// db/scripts/investigar-insumo-duplicado.js
//
// Diagnóstico de SOLO LECTURA. Para un insumo+proveedor puntual, muestra
// TODOS los comprobantes de TODOS los días (no solo uno) — para entender
// un patrón de "6 a 8 comprobantes el mismo día" que no es el caso simple
// de caja/unidad ya resuelto.
//
// Uso: node db/scripts/investigar-insumo-duplicado.js <business_id> <insumo_id> <proveedor_id>
'use strict';
require('dotenv').config();
const pool = require('../../config/db');

async function main() {
  const businessId = Number(process.argv[2]);
  const insumoId = process.argv[3] != null ? Number(process.argv[3]) : null;
  const proveedorId = Number(process.argv[4]);
  if (!Number.isFinite(businessId) || !Number.isFinite(proveedorId)) {
    console.log('Uso: node db/scripts/investigar-insumo-duplicado.js <business_id> <insumo_id|null> <proveedor_id>');
    process.exit(1);
  }

  const { rows: insumo } = insumoId
    ? await pool.query(`SELECT id, nombre, codigo_maxi, precio_ref FROM insumos WHERE id = $1`, [insumoId])
    : { rows: [] };
  console.log('=== Insumo ===');
  console.log(insumo[0] || '(insumo_id null — líneas sin insumo asociado)');

  const { rows: proveedor } = await pool.query(
    `SELECT id, nombre, cuit FROM suppliers WHERE id = $1`, [proveedorId]
  );
  console.log('\n=== Proveedor ===');
  console.log(proveedor[0] || `(proveedor ${proveedorId} no encontrado en suppliers)`);

  const { rows } = await pool.query(
    `SELECT p.id AS purchase_id, p.factura_key, p.fecha, p.branch_id, p.batch_id,
            pi.id AS item_id, pi.cantidad, pi.precio, pi.precio_total, pi.referencia
       FROM purchase_items pi
       JOIN purchases p ON p.id = pi.purchase_id
      WHERE pi.business_id = $1 AND p.proveedor_id = $2
        AND (($3::int IS NULL AND pi.insumo_id IS NULL) OR pi.insumo_id = $3)
      ORDER BY p.fecha DESC, p.factura_key
      LIMIT 60`,
    [businessId, proveedorId, insumoId]
  );
  console.log(`\n=== Líneas (${rows.length}, hasta 60) ===`);
  console.table(rows);

  await pool.end();
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
