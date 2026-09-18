// db/scripts/diag-costo-insumo.js
//
// Igual que diag-costo-articulo.js pero para la receta de un INSUMO ELABORADO
// (recetas.insumo_id en vez de article_id) — para comparar lo que está persistido
// en DB contra lo que muestra el modal de receta del insumo (que recalcula en vivo).
//
// Uso:
//   node db/scripts/diag-costo-insumo.js --business=147 --insumo=300318
//
'use strict';
require('dotenv').config();
const pool = require('../../config/db');

const bizArg = process.argv.find(a => a.startsWith('--business='));
const insArg = process.argv.find(a => a.startsWith('--insumo='));
const bizId = bizArg ? Number(bizArg.split('=')[1]) : null;
const insumoId = insArg ? Number(insArg.split('=')[1]) : null;

async function main() {
  if (!bizId || !insumoId) {
    console.error('Uso: node db/scripts/diag-costo-insumo.js --business=ID --insumo=ID');
    process.exit(1);
  }

  const { rows: insRows } = await pool.query(
    `SELECT id, nombre, unidad_med, precio_ref, es_elaborado, tiene_receta, costo_receta, updated_at
       FROM insumos WHERE id = $1 AND business_id = $2`,
    [insumoId, bizId]
  );
  if (!insRows.length) {
    console.log(`No hay insumo id=${insumoId} en business_id=${bizId}`);
    await pool.end();
    return;
  }
  console.log('── INSUMO ──');
  console.log(insRows[0]);
  console.log('');

  const { rows: recRows } = await pool.query(
    `SELECT id, insumo_id, costo_total, costo_unitario, porciones,
            rendimiento_unidad, rendimiento_peso, unidad_peso, active, updated_at
       FROM recetas
      WHERE insumo_id = $1 AND business_id = $2`,
    [insumoId, bizId]
  );

  if (!recRows.length) {
    console.log(`No hay receta para insumo_id=${insumoId} en business_id=${bizId}`);
    await pool.end();
    return;
  }

  const rec = recRows[0];
  console.log('── RECETA DEL ELABORADO (persistida en DB) ──');
  console.log(rec);
  console.log('');

  const { rows: items } = await pool.query(
    `SELECT ri.id, ri.insumo_id, ri.cantidad, ri.unidad,
            ri.costo_unitario, ri.tipo_costo, ri.merma, ri.merma_id, ri.merma_ids,
            ROUND(ri.cantidad * ri.costo_unitario, 4) AS costo_total_item,
            i.nombre AS insumo_nombre, i.es_elaborado, i.tiene_receta,
            i.precio_ref AS insumo_precio_ref_actual, i.unidad_med, i.updated_at AS insumo_updated_at
       FROM receta_items ri
       LEFT JOIN insumos i ON i.id = ri.insumo_id
      WHERE ri.receta_id = $1
      ORDER BY ri.orden, ri.id`,
    [rec.id]
  );

  console.log(`── ITEMS (${items.length}) ──`);
  let sumaManual = 0;
  for (const it of items) {
    const totalItem = it.tipo_costo === 'nulo' ? 0 : Number(it.costo_total_item) || 0;
    sumaManual += totalItem;
    console.log({
      insumo: it.insumo_nombre || `#${it.insumo_id}`,
      esElaborado: it.es_elaborado,
      tieneReceta: it.tiene_receta,
      cantidad: Number(it.cantidad),
      unidad: it.unidad,
      costo_unitario_guardado_en_item: Number(it.costo_unitario),
      costo_total_item: totalItem,
      insumo_precio_ref_ACTUAL: it.insumo_precio_ref_actual != null ? Number(it.insumo_precio_ref_actual) : null,
      coincide_con_precio_ref_actual: it.insumo_precio_ref_actual != null
        ? Math.abs(Number(it.costo_unitario) - Number(it.insumo_precio_ref_actual)) < 0.01
        : null,
      tipo_costo: it.tipo_costo,
      merma_id: it.merma_id,
      insumo_updated_at: it.insumo_updated_at,
    });
  }

  console.log('');
  console.log(`Suma manual de items: ${sumaManual.toFixed(2)}`);
  console.log(`costo_total guardado en recetas: ${Number(rec.costo_total).toFixed(2)}`);
  console.log(`costo_unitario guardado en recetas: ${Number(rec.costo_unitario).toFixed(4)} (porciones=${rec.porciones}, rendimiento_unidad=${rec.rendimiento_unidad})`);
  console.log(`precio_ref ACTUAL del insumo elaborado: ${Number(insRows[0].precio_ref).toFixed(4)}`);
  console.log(`¿costo_unitario de la receta coincide con precio_ref del insumo? ${Math.abs(Number(rec.costo_unitario) - Number(insRows[0].precio_ref)) < 0.01 ? 'SÍ' : 'NO — el insumo tiene un precio_ref que NO corresponde al costo real de su propia receta'}`);

  await pool.end();
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
