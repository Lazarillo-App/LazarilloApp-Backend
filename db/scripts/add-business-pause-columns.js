// db/scripts/add-business-pause-columns.js
// Agrega las columnas de pausado a app_businesses (panel de super-admin):
// paused_at/paused_reason/paused_by/paused_by_cascade. Sin esto, el middleware
// de bloqueo (loadActiveBusiness) y los endpoints de pausar/despausar fallarían
// contra columnas inexistentes.
//
// Uso: node db/scripts/add-business-pause-columns.js [--dry-run]
require('dotenv').config();
const pool = require('../../config/db');

const COLUMNS = [
  { name: 'paused_at', ddl: `ALTER TABLE app_businesses ADD COLUMN IF NOT EXISTS paused_at TIMESTAMPTZ` },
  { name: 'paused_reason', ddl: `ALTER TABLE app_businesses ADD COLUMN IF NOT EXISTS paused_reason TEXT` },
  { name: 'paused_by', ddl: `ALTER TABLE app_businesses ADD COLUMN IF NOT EXISTS paused_by BIGINT REFERENCES app_users(id) ON DELETE SET NULL` },
  { name: 'paused_by_cascade', ddl: `ALTER TABLE app_businesses ADD COLUMN IF NOT EXISTS paused_by_cascade BOOLEAN NOT NULL DEFAULT false` },
];

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  const { rows: existing } = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'app_businesses' AND column_name = ANY($1)`,
    [COLUMNS.map(c => c.name)]
  );
  const existingSet = new Set(existing.map(r => r.column_name));

  for (const c of COLUMNS) {
    console.log(`Columna ${c.name}: ${existingSet.has(c.name) ? 'ya existe' : 'no existe todavía'}`);
  }

  if (dryRun) {
    await pool.end();
    return;
  }

  for (const c of COLUMNS) {
    if (existingSet.has(c.name)) continue;
    await pool.query(c.ddl);
    console.log(`Columna ${c.name} agregada.`);
  }

  console.log('Listo.');
  await pool.end();
}

main().catch((e) => {
  console.error('add-business-pause-columns error:', e);
  process.exit(1);
});
