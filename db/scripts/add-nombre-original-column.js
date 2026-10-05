// db/scripts/add-nombre-original-column.js
//
// Agrega nombre_original a maxi_articles y app_articles: el nombre tal cual vino
// del POS/sync (o el que tenía al cargarlo a mano), congelado la primera vez que
// alguien lo renombra desde Lazarillo — para poder mostrar "nombre original" junto
// al nombre editable en el modal de edición, sin perder de dónde salió.
//
// Idempotente — correr una sola vez en Render Shell:
//   node db/scripts/add-nombre-original-column.js
'use strict';
require('dotenv').config();
const pool = require('../../config/db');

async function main() {
  await pool.query(`ALTER TABLE maxi_articles ADD COLUMN IF NOT EXISTS nombre_original TEXT;`);
  await pool.query(`ALTER TABLE app_articles   ADD COLUMN IF NOT EXISTS nombre_original TEXT;`);
  console.log('OK — nombre_original agregada a maxi_articles y app_articles.');
  await pool.end();
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
