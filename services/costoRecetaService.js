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
       FROM receta_items ri WHERE ri.receta_id = $1`,
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

module.exports = { recalcularCostoReceta, recalcularCostoRecetas };