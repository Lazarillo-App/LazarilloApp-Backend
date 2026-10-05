// db/scripts/add-nombre-original-insumos.js
//
// Agrega nombre_original a insumos: mismo criterio que add-nombre-original-column.js
// (artículos) — el nombre tal cual vino del POS/sync (o el que tenía al cargarlo a
// mano), congelado la primera vez que alguien lo renombra desde Lazarillo.
//
// Idempotente — correr una sola vez en Render Shell:
//   node db/scripts/add-nombre-original-insumos.js
'use strict';
require('dotenv').config();
const pool = require('../../config/db');

async function main() {
  await pool.query(`ALTER TABLE insumos ADD COLUMN IF NOT EXISTS nombre_original TEXT;`);
  console.log('OK — nombre_original agregada a insumos.');
  await pool.end();
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
