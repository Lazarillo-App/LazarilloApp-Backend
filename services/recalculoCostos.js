// services/recalculoCostos.js
//
// Recalcula de una vez el costo de los insumos de un negocio (precio_ref según la
// configuración de "Precio de costeo": modo + con/sin impuestos) y el de TODAS las
// recetas de la organización que los usan (con desperdicio y mermas, igual que el modal).
//
// Se usa:
//  - al guardar la configuración de costeo (antes el cambio recién se aplicaba con la
//    próxima compra que entraba, y la tabla seguía mostrando costos con el criterio viejo);
//  - en la tarea única de unificación de costos (tareasUnicas/unificarCostosRecetas.js).
//
// Igual que el sync de compras y la tarea única del 10/11: las compras se leen del negocio
// donde se registraron y el precio se aplica al insumo (que vive en el negocio principal).
// Si un insumo tiene compras en varios negocios, gana la compra más reciente.
'use strict';

const pool = require('../config/db');
const { getModoCosteo, getConImpuestos, calcularPreciosPorModo, aplicarPreciosCosteo, guardarCostosLocales } = require('./precioCosteoInsumos');
const { propagarCostoInsumo, getOrgBizIds } = require('./costoRecetaService');

/**
 * @param {number} insBiz  negocio dueño de los insumos (el principal de la organización)
 * @returns {Promise<{insumosConPrecio:number, preciosActualizados:number, insumosPropagados:number}>}
 */
async function recalcularCostosDeNegocio(insBiz) {
  const client = await pool.connect();
  try {
    const modo = await getModoCosteo(insBiz, client);
    const conImpuestos = await getConImpuestos(insBiz, client);

    // 1. precio_ref de cada insumo según el modo (si el modo no es "precio fijo")
    let preciosActualizados = 0;
    let insumosConPrecio = 0;
    const precios = new Map();
    const preciosPorLocal = new Map();   // local → Map(insumo → precio)
    if (modo !== 'precio_db') {
      const { rows } = await client.query(
        `SELECT pi.business_id AS compra_biz, pi.insumo_id, MAX(pi.fecha) AS ult
           FROM purchase_items pi JOIN insumos i ON i.id = pi.insumo_id
          WHERE i.business_id = $1
          GROUP BY 1, 2`,
        [insBiz]
      );
      const porCompra = new Map();   // compra_biz → [insumo_id]
      const ultima = new Map();      // `${insumo}|${compra_biz}` → fecha
      for (const r of rows) {
        const cb = Number(r.compra_biz), id = Number(r.insumo_id);
        if (!porCompra.has(cb)) porCompra.set(cb, []);
        porCompra.get(cb).push(id);
        ultima.set(`${id}|${cb}`, new Date(r.ult).getTime());
      }
      const elegido = new Map();     // insumo → { precio, fecha }
      for (const [compraBiz, ids] of porCompra) {
        const p = await calcularPreciosPorModo(client, compraBiz, ids, modo, { conImpuestos });
        if (!p) continue;
        preciosPorLocal.set(compraBiz, p);
        for (const [id, precio] of p) {
          const f = ultima.get(`${id}|${compraBiz}`) || 0;
          const prev = elegido.get(id);
          if (!prev || f > prev.fecha) elegido.set(id, { precio, fecha: f });
        }
      }
      for (const [id, v] of elegido) precios.set(id, v.precio);
      insumosConPrecio = precios.size;
    }

    await client.query('BEGIN');
    if (precios.size) preciosActualizados = (await aplicarPreciosCosteo(client, insBiz, precios)).length;
    // Costo por local: se rehace entero para los insumos de este negocio. Con "precio fijo"
    // (precio_db) no hay costo por compras: se borra y todas las recetas usan precio_ref.
    await client.query(
      `DELETE FROM insumo_costos_local WHERE insumo_id IN (SELECT id FROM insumos WHERE business_id = $1)`,
      [insBiz]
    );
    for (const [local, p] of preciosPorLocal) await guardarCostosLocales(client, local, p);

    // 2. Propagar TODOS los insumos simples que están en alguna receta activa de la
    //    organización (no solo los que cambiaron de precio): así cada receta queda con el
    //    mismo cálculo que el modal (desperdicio + mermas) aunque su precio no se haya movido.
    //    Los elaborados se actualizan solos en la cascada (propagarCostoInsumo sube de nivel).
    const orgIds = await getOrgBizIds(insBiz, client);
    const { rows: usados } = await client.query(
      `SELECT DISTINCT ri.insumo_id
         FROM receta_items ri
         JOIN recetas r ON r.id = ri.receta_id AND r.active = TRUE
         JOIN insumos i ON i.id = ri.insumo_id AND i.business_id = $1
        WHERE r.business_id = ANY($2::int[])
          AND NOT EXISTS (
            SELECT 1 FROM recetas re
             WHERE re.insumo_id = i.id AND re.active = TRUE
               AND EXISTS (SELECT 1 FROM receta_items rie WHERE rie.receta_id = re.id)
          )`,
      [insBiz, orgIds]
    );
    for (const { insumo_id } of usados) await propagarCostoInsumo(Number(insumo_id), insBiz, client);
    await client.query('COMMIT');

    return { insumosConPrecio, preciosActualizados, insumosPropagados: usados.length };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* nada */ }
    throw e;
  } finally {
    client.release();
  }
}

/** Negocios de la organización de `bizId` que tienen insumos cargados (normalmente uno: el principal). */
async function negociosConInsumos(bizId) {
  const orgIds = await getOrgBizIds(bizId);
  const { rows } = await pool.query(
    `SELECT DISTINCT business_id FROM insumos WHERE business_id = ANY($1::int[])`,
    [orgIds]
  );
  return rows.map((r) => Number(r.business_id));
}

module.exports = { recalcularCostosDeNegocio, negociosConInsumos };
