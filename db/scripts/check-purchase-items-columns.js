// db/scripts/check-purchase-items-columns.js
//
// Diagnóstico de SOLO LECTURA. purchasesStore.js espera una columna
// `sucursal` en purchase_items que en producción no existe (error real al
// correr sync-maxi-pipeline-compras.js --aplicar: "column sucursal of
// relation purchase_items does not exist"). Antes de agregar nada, ver qué
// columnas tiene realmente hoy la tabla.
//
// Uso: node db/scripts/check-purchase-items-columns.js
'use strict';
require('dotenv').config();
const pool = require('../../config/db');

async function main() {
  const cols = await pool.query(
    `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_name = 'purchase_items' ORDER BY ordinal_position`
  );
  console.table(cols.rows);
  await pool.end();
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
