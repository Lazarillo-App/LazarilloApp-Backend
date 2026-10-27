// db/scripts/diagnosticar-precio-insumo.js
//
// Diagnóstico de SOLO LECTURA para un insumo puntual. El pantallazo del chip
// de precio usa insumos.precio_ref directo; el backfill de bonificaciones
// recalcula "última compra" agrupando por (factura_key, proveedor_id) SOLO
// dentro de un negocio, igual que calcularPreciosPorModo. Si ese agrupado NO
// marca el insumo como "a corregir" pero el precio mostrado es absurdo, la
// fila sucia ya está adentro del cálculo — hay que verla agrupada, no la
// vista de "últimas 10" que puede estar filtrando o paginando distinto.
//
// Uso: node db/scripts/diagnosticar-precio-insumo.js <insumo_id> [--business=N]
'use strict';
require('dotenv').config();
const pool = require('../../config/db');

async function main() {
  const insumoId = Number(process.argv[2]);
  const bizArg = process.argv.find((a) => a.startsWith('--business='));
  if (!Number.isFinite(insumoId)) {
    console.log('Uso: node db/scripts/diagnosticar-precio-insumo.js <insumo_id> [--business=N]');
    process.exit(1);
  }

  const { rows: insRows } = await pool.query(
    `SELECT id, nombre, business_id, precio_ref, unidad_med, codigo_maxi,
            bonif_aceptada, bonif_ratio, bonif_descartada_factura
       FROM insumos WHERE id = $1`,
    [insumoId]
  );
  if (!insRows.length) {
    console.log(`Insumo ${insumoId} no encontrado.`);
    await pool.end();
    return;
  }
  const ins = insRows[0];
  const businessId = bizArg ? Number(bizArg.split('=')[1]) : ins.business_id;
  console.log('=== Insumo ===');
  console.log(ins);

  // ¿Es un elaborado? (tiene una receta propia activa)
  const { rows: recRows } = await pool.query(
    `SELECT id, nombre, costo_total, costo_unitario, rendimiento_unidad, active
       FROM recetas WHERE insumo_id = $1 AND business_id = $2`,
    [insumoId, businessId]
  );
  console.log(`\n=== Receta propia (elaborado?) — ${recRows.length} fila(s) ===`);
  console.table(recRows);

  for (const rec of recRows) {
    const { rows: itemsRec } = await pool.query(
      `SELECT ri.id, ri.insumo_id, i2.nombre AS ingrediente, ri.cantidad, ri.unidad, ri.costo_unitario
         FROM receta_items ri
         LEFT JOIN insumos i2 ON i2.id = ri.insumo_id
        WHERE ri.receta_id = $1`,
      [rec.id]
    );
    console.log(`\n--- Ingredientes de la receta ${rec.id} "${rec.nombre}" — ${itemsRec.length} línea(s) ---`);
    console.table(itemsRec);
  }

  // TODOS los grupos (factura_key, proveedor_id) para este insumo en este
  // negocio — mismo agrupado que calcularPreciosPorModo (ultima_compra).
  const { rows: grupos } = await pool.query(
    `SELECT pi.insumo_id, p.factura_key, p.proveedor_id,
            MAX(p.fecha) AS fecha, MAX(p.id) AS pid, MIN(p.id) AS pid_min,
            SUM(pi.precio_total) AS importe, SUM(pi.cantidad) AS unidades,
            ROUND((SUM(pi.precio_total) / NULLIF(SUM(pi.cantidad), 0))::numeric, 4) AS precio_calculado,
            COUNT(pi.id) AS lineas
       FROM purchase_items pi
       JOIN purchases p ON p.id = pi.purchase_id
      WHERE pi.business_id = $1 AND pi.insumo_id = $2
      GROUP BY pi.insumo_id, p.factura_key, p.proveedor_id
      ORDER BY fecha DESC, pid DESC`,
    [businessId, insumoId]
  );
  console.log(`\n=== Grupos factura_key+proveedor (orden = el que usa "última_compra") — negocio ${businessId} ===`);
  console.table(grupos);
  if (grupos.length) {
    console.log(`>>> GANADOR (el que calcularPreciosPorModo elegiría): factura_key=${grupos[0].factura_key} precio=${grupos[0].precio_calculado}`);
  }

  // Detalle de líneas crudas del grupo ganador, para ver qué fila específica
  // tiene la cantidad/precio corrupto.
  if (grupos.length) {
    const g = grupos[0];
    const { rows: detalle } = await pool.query(
      `SELECT pi.id, pi.fecha, pi.cantidad, pi.neto, pi.precio, pi.precio_total,
              pi.branch_id, pi.orden_compra, pi.referencia
         FROM purchase_items pi
         JOIN purchases p ON p.id = pi.purchase_id
        WHERE pi.business_id = $1 AND pi.insumo_id = $2
          AND p.factura_key = $3 AND p.proveedor_id IS NOT DISTINCT FROM $4`,
      [businessId, insumoId, g.factura_key, g.proveedor_id]
    );
    console.log(`\n=== Líneas crudas del grupo ganador (factura_key=${g.factura_key}) ===`);
    console.table(detalle);
  }

  await pool.end();
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
