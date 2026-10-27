// db/scripts/check-insumo-precio.js
//
// Diagnóstico de SOLO LECTURA. Muestra precio_ref, bonif_aceptada y las
// últimas compras de un insumo — para confirmar si un precio raro en la
// pantalla (ej. muy distinto a las compras recientes) es porque
// bonif_aceptada está trabado (precioCosteoInsumos.js nunca lo actualiza
// mientras ese flag esté en true).
//
// Uso: node db/scripts/check-insumo-precio.js <insumo_id>
'use strict';
require('dotenv').config();
const pool = require('../../config/db');

async function main() {
  const insumoId = Number(process.argv[2]);
  if (!Number.isFinite(insumoId)) {
    console.log('Uso: node db/scripts/check-insumo-precio.js <insumo_id>');
    process.exit(1);
  }

  const { rows } = await pool.query(
    `SELECT id, business_id, nombre, unidad_med, precio_ref, bonif_aceptada, updated_at
       FROM insumos WHERE id = $1`,
    [insumoId]
  );
  if (!rows.length) {
    console.log('No existe ese insumo.');
    await pool.end();
    return;
  }
  console.log('=== Insumo ===');
  console.log(rows[0]);

  const compras = await pool.query(
    `SELECT p.fecha, p.factura_key, pi.cantidad, pi.precio, pi.precio_total
       FROM purchase_items pi
       JOIN purchases p ON p.id = pi.purchase_id
      WHERE pi.insumo_id = $1
      ORDER BY p.fecha DESC
      LIMIT 10`,
    [insumoId]
  );
  console.log('\n=== Últimas 10 compras ===');
  console.table(compras.rows);

  await pool.end();
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
