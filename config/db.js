// config/db.js
require('dotenv').config();
const { Pool } = require('pg');

const connStr =
  process.env.DATABASE_URL ||
  `postgres://${process.env.PGUSER || 'postgres'}:${process.env.PGPASSWORD || ''}` +
  `@${process.env.PGHOST || 'localhost'}:${process.env.PGPORT || 5432}/${process.env.PGDATABASE || 'agrupaciones_db'}`;

const needsSSL = !/localhost|127\.0\.0\.1/i.test(connStr);

const pool = new Pool({
  connectionString: connStr,
  ssl: needsSSL ? { rejectUnauthorized: false } : false
});

module.exports = pool;