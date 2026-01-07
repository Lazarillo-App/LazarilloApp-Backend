// db/migrations.js
const fs = require('fs');
const path = require('path');
const pool = require('../config/db');

// JS migrations live
const m004 = require('./migrations/live/004_auth');
const m005 = require('./migrations/live/005_business_branding');

let m008 = null;
try {
  m008 = require('./migrations/live/008_agrupaciones_multitenant');
} catch {
  /* opcional */
}

const IDEMPOTENT_ERRORS = new Set([
  '42710', // duplicate_object
  '42701', // duplicate_column
  '23505', // unique_violation
  '42P07', // duplicate_table / index
  '23503', // foreign_key_violation (en migraciones legacy)
]);

async function runMigrations() {
  const execSafe = async (sql) => {
    try {
      await pool.query(sql);
    } catch (e) {
      if (IDEMPOTENT_ERRORS.has(e.code)) return;
      throw e;
    }
  };

  console.log('🗄️  DB:', process.env.PGDATABASE || '(desconocida)');

  /* ===== Extensiones ===== */
  await execSafe(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);
  await execSafe(`CREATE EXTENSION IF NOT EXISTS citext;`);
  await execSafe(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);

  /* ===== Migraciones JS ===== */
  await m004.up(pool);
  await m005.up(pool);
  if (m008?.up) await m008.up(pool);

  console.log('🔧 Migraciones JS OK');

  /* ===== Migraciones SQL ===== */
  const liveDir = path.join(__dirname, 'migrations', 'live');
  const sqlFiles = fs.readdirSync(liveDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  let executed = 0;

  for (const file of sqlFiles) {
    const sql = fs.readFileSync(path.join(liveDir, file), 'utf8');
    try {
      await pool.query(sql);
      executed++;
    } catch (e) {
      if (IDEMPOTENT_ERRORS.has(e.code)) continue;

      console.error(`❌ Migration failed: ${file}`);
      console.error(`   ${e.code} - ${e.message}`);
      throw e;
    }
  }

  console.log(`📦 SQL migrations OK (${executed})`);
  console.log('🚀 Schema ready');
}

module.exports = { runMigrations };