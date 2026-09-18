// services/costoRecetaService.js
// Fuente ÚNICA de verdad para el costo materializado de una receta.
// Cualquier controller que toque items/rendimiento/merma debe llamar acá,
// dentro de su misma transacción, pasando el client.

const pool = require('../config/db');

/**
 * Recalcula y PERSISTE costo_total, costo_unitario y costo_total_con_merma
 * de una receta. Devuelve el row actualizado.
 *
 * Reglas de costo_unitario según rendimiento_unidad:
 *   - porcion | u      → costo_total / porciones
 *   - gr | kg          → costo_total / rendimiento_peso_en_gr   (por gr)
 *   - ml | lt          → costo_total / rendimiento_peso_en_ml   (por ml)
 * El footer/vista deriva por kg/L multiplicando ×1000; acá guardamos base.
 *
 * @param {number} recetaId
 * @param {object} db  client de una transacción, o pool si es standalone
 */
async function recalcularCostoReceta(recetaId, db = pool) {
  // 1. costo_total = SUM(cantidad × costo_unitario) de los items
  const { rows: recRows } = await db.query(
    `SELECT id, porciones, rendimiento_unidad, rendimiento_peso, unidad_peso
       FROM recetas WHERE id = $1`,
    [recetaId]
  );
  if (!recRows.length) return null;
  const rec = recRows[0];

  const { rows: sumRows } = await db.query(
    `SELECT COALESCE(SUM(ri.cantidad * ri.costo_unitario), 0) AS total
       FROM receta_items ri
      WHERE ri.receta_id = $1
        AND ri.tipo_costo IS DISTINCT FROM 'nulo'`,
    [recetaId]
  );
  const costoTotal = Number(sumRows[0].total) || 0;

  // 2. Resolver divisor de rendimiento y la unidad en que queda el costo unitario.
  //    - porcion/u (con o sin rendimiento_peso) → divisor = porciones; costo por unidad.
  //      rendimiento_peso/unidad_peso es solo el peso EQUIVALENTE de 1 unidad (dato
  //      informativo para conversiones — ej. poder usar este elaborado como "150gr" en
  //      otra receta en vez de "0.5 u"), NO el peso a dividir acá. Antes, si había un
  //      rendimiento_peso cargado, el divisor pasaba a ser ESE peso (300gr) en vez de
  //      porciones (40 unidades) — costo_unitario/precio_ref terminaba siendo el costo
  //      del LOTE ENTERO dividido por el peso de UNA sola unidad (ej. $52.303,83/300 =
  //      $174,35), un número que no es "por unidad" ni "por gramo" de nada real, y que
  //      se propagaba tal cual a cualquier receta que use este elaborado.
  //    - medible directo (gr/kg/ml/lt) → divisor = porciones (que YA está en esa
  //      unidad); costo por 1 unidad de rendimiento. (Antes caía al fallback ÷1
  //      porque buscaba rendimiento_peso, que es NULL en este caso → bug del
  //      precio_ref = costo del lote entero.)
  const unidad = String(rec.rendimiento_unidad || 'porcion').toLowerCase().trim();
  const MEDIBLES = ['gr', 'kg', 'ml', 'lt'];
  let divisor;
  let unidadCostoUnitario;   // en qué unidad queda costoUnitario
  if (unidad === 'porcion' || unidad === 'u') {
    divisor = Number(rec.porciones) || 1;
    unidadCostoUnitario = 'u';
  } else if (MEDIBLES.includes(unidad)) {
    // porciones está expresado EN la unidad de rendimiento (ej: 300 gr, 8.35 kg)
    divisor = Number(rec.porciones) || 1;
    unidadCostoUnitario = unidad;
  } else {
    divisor = Number(rec.porciones) || 1;
    unidadCostoUnitario = 'u';
  }
  const costoUnitario = divisor > 0 ? costoTotal / divisor : 0;

  // 3. Merma: preparado para merma-por-negocio. Por ahora = costo_total.
  //    Cuando implementemos #3 (merma por local), acá se suma el ajuste.
  const costoTotalConMerma = costoTotal;

  // 4. Persistir
  const { rows: upd } = await db.query(
    `UPDATE recetas
        SET costo_total           = $2,
            costo_unitario        = $3,
            costo_total_con_merma = $4,
            updated_at            = NOW()
      WHERE id = $1
      RETURNING *`,
    [
      recetaId,
      Number(costoTotal.toFixed(4)),
      Number(costoUnitario.toFixed(6)),
      Number(costoTotalConMerma.toFixed(4)),
    ]
  );
  return upd[0] ? { ...upd[0], _unidad_costo_unitario: unidadCostoUnitario } : null;
}

/**
 * Recalcula varias recetas (mismo client/transacción).
 */
async function recalcularCostoRecetas(recetaIds, db = pool) {
  const ids = [...new Set((recetaIds || []).map(Number).filter(n => n))];
  const out = [];
  for (const id of ids) {
    out.push(await recalcularCostoReceta(id, db));
  }
  return out;
}

/**
 * Propaga en cascada el cambio de costo de un insumo hacia todas las recetas
 * que lo usan como ingrediente (directa o indirectamente, para elaborados anidados).
 *
 * Flujo por nivel:
 *  1. Busca receta_items que referencian este insumo.
 *  2. Actualiza su costo_unitario con el precio_ref actual del insumo,
 *     convertido a la unidad del item.
 *  3. Recalcula el costo_total de las recetas afectadas.
 *  4. Para cada receta afectada que sea de un ELABORADO (tiene insumo_id):
 *     - sincroniza el precio_ref de ese elaborado con su nuevo costo_unitario,
 *     - y propaga recursivamente hacia arriba.
 *
 * Los elaborados no forman ciclos, así que la recursión termina. Igual se
 * incluye un guard de profundidad por seguridad.
 *
 * @param {number} insumoId  insumo cuyo costo cambió
 * @param {number} bizId
 * @param {object} db         client de transacción
 * @param {number} depth      profundidad actual (interno)
 */
async function propagarCostoInsumo(insumoId, bizId, db, depth = 0) {
  const { factorConversion } = require('./unidades');
  if (depth > 12) {
    console.warn(`[propagarCostoInsumo] profundidad máxima alcanzada en insumo ${insumoId}`);
    return;
  }

  // Datos del insumo cuyo costo cambió: su precio_ref (costo por unidad de rendimiento)
  // y la unidad base en la que está expresado.
  const { rows: insRows } = await db.query(
    `SELECT i.id, i.precio_ref, i.unidad_med, i.contenido_envase, i.unidad_envase,
            r.rendimiento_unidad, r.rendimiento_peso, r.unidad_peso
       FROM insumos i
       LEFT JOIN recetas r ON r.insumo_id = i.id AND r.business_id = $2 AND r.active = TRUE
      WHERE i.id = $1`,
    [insumoId, bizId]
  );
  if (!insRows.length) return;
  const ins = insRows[0];
  const precioRef = Number(ins.precio_ref) || 0;
  const contEnvase = Number(ins.contenido_envase) || 0;
  const uniEnvase = String(ins.unidad_envase || '').toLowerCase().trim();

  // Unidad base del costo del insumo:
  //  - si es elaborado con rendimiento medible (gr/kg/ml/lt) → esa unidad
  //  - si rinde en porcion/u → 'u' (no se convierte por peso)
  //  - si no es elaborado → su unidad_med
  const rendU = String(ins.rendimiento_unidad || '').toLowerCase().trim();
  const pesoEquiv = Number(ins.rendimiento_peso) || 0;   // peso de 1 porción (equivalente)
  const unidadPesoEquiv = String(ins.unidad_peso || 'gr').toLowerCase().trim();
  let unidadBase;
  let costoPorGrBase = 0;   // costo por unidad base de peso, si aplica equivalente
  if (['gr','kg','ml','lt'].includes(rendU)) {
    // Rinde directamente en peso/volumen: precio_ref ya es por esa unidad
    unidadBase = rendU;
  } else if ((rendU === 'porcion' || rendU === 'u') && pesoEquiv > 0) {
    // Rinde en porción CON equivalente: precio_ref es por porción, pero se puede
    // usar en peso. costo por gr = precio_ref / peso_equivalente (en gr).
    const pesoEnGr = unidadPesoEquiv === 'kg' ? pesoEquiv * 1000
      : unidadPesoEquiv === 'lt' ? pesoEquiv * 1000
      : pesoEquiv;  // gr o ml
    costoPorGrBase = pesoEnGr > 0 ? precioRef / pesoEnGr : 0;
    // unidad base física según el equivalente (gr para peso, ml para volumen)
    unidadBase = (unidadPesoEquiv === 'kg' || unidadPesoEquiv === 'gr') ? 'gr' : 'ml';
  } else {
    // Rinde en porción/u SIN equivalente, o no es elaborado
    unidadBase = (rendU === 'porcion' || rendU === 'u') ? 'u'
      : String(ins.unidad_med || 'u').toLowerCase().trim();
  }

  // 1. Items que usan este insumo (en cualquier receta del biz)
  const { rows: items } = await db.query(
    `SELECT ri.id, ri.receta_id, ri.unidad
       FROM receta_items ri
       JOIN recetas r ON r.id = ri.receta_id
      WHERE ri.insumo_id = $1 AND r.business_id = $2`,
    [insumoId, bizId]
  );
  if (!items.length) return;

  // Equivalencias propias del insumo (ej. "cucharon" = 60ml) — un item puede tener
  // guardada una de estas como su `unidad` en vez de una unidad física. Sin este chequeo,
  // factorConversion no reconoce el nombre, devuelve 1 (sin convertir) y el costo
  // propagado queda siendo el precio de TODA una unidad física (ej. $/lt entero) en vez
  // del costo de la porción real que representa la equivalencia (ej. $/cucharon).
  const { rows: equivalencias } = await db.query(
    `SELECT nombre, contenido, unidad FROM insumo_equivalencias WHERE insumo_id = $1`,
    [insumoId]
  );
  const costoPorUnidadBase = costoPorGrBase > 0 ? costoPorGrBase : precioRef;

  // 2. Actualizar costo_unitario de cada item (convertido a su unidad)
  for (const it of items) {
    const unidadItem = String(it.unidad || unidadBase || 'u').toLowerCase().trim();
    const eqSel = equivalencias.find(e => String(e.nombre || '').trim().toLowerCase() === unidadItem);
    let nuevoCosto;
    if (eqSel) {
      const contenido = Number(eqSel.contenido) || 0;
      const factor = factorConversion(unidadBase, eqSel.unidad);
      nuevoCosto = factor > 0 ? contenido * (costoPorUnidadBase / factor) : contenido * costoPorUnidadBase;
    } else if (costoPorGrBase > 0) {
      // Elaborado en porción con equivalente: costo por gr base, convertido a la unidad del item.
      // Si el item lo usa en porción/u, usar el costo por porción directo.
      if (unidadItem === 'u' || unidadItem === 'porcion') {
        nuevoCosto = precioRef;   // por porción
      } else {
        const factor = factorConversion(unidadBase, unidadItem);  // gr→kg = 1000, gr→gr = 1
        nuevoCosto = factor > 0 ? costoPorGrBase / factor : costoPorGrBase;
      }
    } else if (unidadBase === 'u' && contEnvase > 0 && uniEnvase && unidadItem !== 'u') {
      // Insumo "u" CON envase (ej. una botella de 30ml a $3.549,99/u) usado en la
      // receta por una unidad física (ml/gr/etc): el costo real es precioRef ÷
      // contenido_envase, convertido a esa unidad — NO el precio de la unidad/
      // envase entero. Sin esto, 10ml de esa botella se costeaban como $3.549,99
      // (el precio de TODA la botella) en vez de la fracción real que representan
      // esos 10ml — mismo cálculo que ya hace el frontend (calcCosto.js) para
      // mostrar el costo en pantalla, pero que acá, al propagar, no se aplicaba.
      const costoPorUnidadEnvase = precioRef / contEnvase;
      const factorEnv = factorConversion(unidadItem, uniEnvase);
      nuevoCosto = factorEnv > 0 ? factorEnv * costoPorUnidadEnvase : costoPorUnidadEnvase;
    } else if (unidadBase === 'u') {
      nuevoCosto = precioRef;   // por porción/unidad sin equivalente, sin conversión
    } else {
      const factor = factorConversion(unidadBase, unidadItem);
      nuevoCosto = factor > 0 ? precioRef / factor : precioRef;
    }
    await db.query(
      `UPDATE receta_items SET costo_unitario = $1, updated_at = NOW() WHERE id = $2`,
      [Number(nuevoCosto.toFixed(6)), it.id]
    );
  }

  // 3. Recalcular las recetas afectadas
  const recetaIds = [...new Set(items.map(it => it.receta_id))];
  const recetasActualizadas = await recalcularCostoRecetas(recetaIds, db);

  // 4. Para cada receta afectada que sea de un elaborado, sincronizar su
  //    precio_ref y propagar otro nivel.
  for (const rec of recetasActualizadas) {
    if (rec && rec.insumo_id) {
      // El costo del elaborado cambió → actualizar su precio_ref
      await db.query(
        `UPDATE insumos
            SET precio_ref = $1, costo_receta = $2, updated_at = NOW()
          WHERE id = $3 AND business_id = $4`,
        [
          Number((Number(rec.costo_unitario) || 0).toFixed(6)),
          Number((Number(rec.costo_total) || 0).toFixed(3)),
          rec.insumo_id, bizId,
        ]
      );
      // Propagar hacia arriba (recetas que usan este elaborado)
      await propagarCostoInsumo(rec.insumo_id, bizId, db, depth + 1);
    }
  }
}

module.exports = { recalcularCostoReceta, recalcularCostoRecetas, propagarCostoInsumo };