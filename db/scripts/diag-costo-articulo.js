// db/scripts/diag-costo-articulo.js
//
// Diagnóstico: muestra la receta de un artículo (persistida en DB) ítem por ítem,
// con el costo_unitario guardado de cada uno y, si es un insumo elaborado, su
// precio_ref actual — para comparar contra lo que muestra el modal de receta (que
// recalcula todo en vivo) y encontrar exactamente qué ítem quedó desincronizado.
//
// Uso:
//   node db/scripts/diag-costo-articulo.js --business=210 --articulo=3014
//
'use strict';
require('dotenv').config();
const pool = require('../../config/db');

const bizArg = process.argv.find(a => a.startsWith('--business='));
const artArg = process.argv.find(a => a.startsWith('--articulo='));
const bizId = bizArg ? Number(bizArg.split('=')[1]) : null;
const articuloId = artArg ? Number(artArg.split('=')[1]) : null;

async function main() {
  if (!bizId || !articuloId) {
    console.error('Uso: node db/scripts/diag-costo-articulo.js --business=ID --articulo=ID');
    process.exit(1);
  }

  const { rows: recRows } = await pool.query(
    `SELECT id, article_id, costo_total, costo_unitario, porciones,
            rendimiento_unidad, rendimiento_peso, unidad_peso, active, updated_at
       FROM recetas
      WHERE article_id = $1 AND business_id = $2`,
    [articuloId, bizId]
  );

  if (!recRows.length) {
    console.log(`No hay receta para article_id=${articuloId} en business_id=${bizId}`);
    await pool.end();
    return;
  }

  const rec = recRows[0];
  console.log('── RECETA (persistida en DB) ──');
  console.log(rec);
  console.log('');

  const { rows: items } = await pool.query(
    `SELECT ri.id, ri.insumo_id, ri.article_ref_id, ri.cantidad, ri.unidad,
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
  console.log(`Suma manual de items (lo que DEBERÍA dar costo_total): ${sumaManual.toFixed(2)}`);
  console.log(`costo_total guardado en recetas: ${Number(rec.costo_total).toFixed(2)}`);
  console.log(`¿Coinciden? ${Math.abs(sumaManual - Number(rec.costo_total)) < 0.01 ? 'SÍ' : 'NO — recetas.costo_total está desincronizado de sus propios items'}`);

  await pool.end();
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
