// scripts/run-migration.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

// 1) LEER CONNECTION STRING PRIMERO
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL no está definida');
  process.exit(1);
}

// 2) DECIDIR SSL LUEGO
let ssl = undefined;
try {
  const u = new URL(connectionString);
  const isLocal = ['localhost', '127.0.0.1'].includes(u.hostname);
  const sslmode  = (u.searchParams.get('sslmode') || '').toLowerCase();
  const sslQuery = (u.searchParams.get('ssl') || '').toLowerCase();

  if (sslmode === 'require' || sslQuery === 'true')       ssl = { rejectUnauthorized: false };
  else if (sslmode === 'disable' || isLocal)              ssl = false;
} catch { /* url inválida: dejar ssl undefined */ }

// 3) LEER ARCHIVO SQL
const file = process.argv[2];
if (!file) {
  console.error('Uso: node scripts/run-migration.js <ruta-sql>');
  process.exit(1);
}
const sqlPath = path.resolve(file);
const sql = fs.readFileSync(sqlPath, 'utf8');

// 4) EJECUTAR
(async () => {
  const client = new Client({ connectionString, ssl });
  try {
    await client.connect();
    await client.query('BEGIN');
    await client.query(sql);   // tu .sql puede tener varias sentencias/DO $$...$$
    await client.query('COMMIT');
    console.log('✅ Migración aplicada OK:', path.basename(sqlPath));
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('❌ Error migración:', e.message, e.code);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
})();

