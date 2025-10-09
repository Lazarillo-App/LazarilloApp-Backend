// scripts/dbpeek.js
require('dotenv').config();
const { Client } = require('pg');

async function run() {
  const sql = process.argv[2] || 'SELECT 1';
  const connStr =
    process.env.DATABASE_URL ||
    `postgres://${process.env.PGUSER || 'postgres'}:${process.env.PGPASSWORD || ''}` +
    `@${process.env.PGHOST || 'localhost'}:${process.env.PGPORT || 5432}/${process.env.PGDATABASE || 'agrupaciones_db'}`;

  const needsSSL = !/localhost|127\.0\.0\.1/i.test(connStr);
  const client = new Client({
    connectionString: connStr,
    ssl: needsSSL ? { rejectUnauthorized: false } : false
  });

  await client.connect();
  const { rows } = await client.query(sql);
  console.table(rows);
  await client.end();
}

run().catch(e => {
  console.error('DB error:', e.message);
  process.exit(1);
});
