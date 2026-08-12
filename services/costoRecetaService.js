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

  // 2. Resolver divisor de rendimiento
  const unidad = String(rec.rendimiento_unidad || 'porcion').toLowerCase().trim();
  let divisor;
  if (unidad === 'porcion' || unidad === 'u') {
    divisor = Number(rec.porciones) || 1;
  } else {
    // rinde por peso/volumen. rendimiento_peso viene en unidad_peso (gr o kg).
    // Normalizamos a base gr (o ml para volumen — mismo número, densidad 1).
    const peso = Number(rec.rendimiento_peso) || 0;
    const up   = String(rec.unidad_peso || 'gr').toLowerCase().trim();
    // rendimiento_peso puede estar en kg → pasar a gr (base)
    const pesoBase = up === 'kg' ? peso * 1000 : peso;
    divisor = pesoBase > 0 ? pesoBase : 1;
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
  return upd[0] || null;
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
    `SELECT i.id, i.precio_ref, i.unidad_med,
            r.rendimiento_unidad, r.rendimiento_peso, r.unidad_peso
       FROM insumos i
       LEFT JOIN recetas r ON r.insumo_id = i.id AND r.business_id = $2 AND r.active = TRUE
      WHERE i.id = $1`,
    [insumoId, bizId]
  );
  if (!insRows.length) return;
  const ins = insRows[0];
  const precioRef = Number(ins.precio_ref) || 0;

  // Unidad base del costo del insumo:
  //  - si es elaborado con rendimiento medible (gr/kg/ml/lt) → esa unidad
  //  - si rinde en porcion/u → 'u' (no se convierte por peso)
  //  - si no es elaborado → su unidad_med
  const rendU = String(ins.rendimiento_unidad || '').toLowerCase().trim();
  let unidadBase;
  if (['gr','kg','ml','lt'].includes(rendU)) {
    unidadBase = rendU;
  } else if (rendU === 'porcion' || rendU === 'u') {
    unidadBase = 'u';
  } else {
    unidadBase = String(ins.unidad_med || 'u').toLowerCase().trim();
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

  // 2. Actualizar costo_unitario de cada item (convertido a su unidad)
  for (const it of items) {
    const unidadItem = String(it.unidad || unidadBase || 'u').toLowerCase().trim();
    let nuevoCosto;
    if (unidadBase === 'u') {
      nuevoCosto = precioRef;   // por porción/unidad, sin conversión de peso
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