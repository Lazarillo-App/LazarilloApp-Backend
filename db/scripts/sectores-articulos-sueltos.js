// db/scripts/sectores-articulos-sueltos.js
// Permite que un sector incluya artículos sueltos (sin agrupación). Idempotente.
// Correr una vez en Render Shell:  node db/scripts/sectores-articulos-sueltos.js
'use strict';
require('dotenv').config();
const pool = require('../../config/db');

async function main() {
  await pool.query(`ALTER TABLE sector_scope_items ALTER COLUMN agrupacion_id DROP NOT NULL`);
  await pool.query(`ALTER TABLE sector_scope_items ADD COLUMN IF NOT EXISTS articulo_id INT`);
  await pool.query(`ALTER TABLE sector_scope_items DROP CONSTRAINT IF EXISTS sector_scope_items_tipo_check`);
  await pool.query(`ALTER TABLE sector_scope_items ADD CONSTRAINT sector_scope_items_tipo_check
                      CHECK (tipo IN ('agrupacion','rubro','subrubro','articulo'))`);
  console.log('OK — sector_scope_items admite artículos sueltos.');
  await pool.end();
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
