// config/db.js
require('dotenv').config();
const { Pool } = require('pg');

const connStr =
  process.env.DATABASE_URL ||
  `postgres://${process.env.PGUSER || 'postgres'}:${process.env.PGPASSWORD || ''}` +
  `@${process.env.PGHOST || 'localhost'}:${process.env.PGPORT || 5432}/${process.env.PGDATABASE || 'agrupaciones_db'}`;

// Permite forzar por env: PGSSLMODE=disable|require
const sslMode = (process.env.PGSSLMODE || '').toLowerCase();
const autoSSL = !/localhost|127\.0\.0\.1/i.test(connStr);
const ssl =
  sslMode === 'disable' ? false :
  sslMode === 'require' ? { rejectUnauthorized: false } :
  (autoSSL ? { rejectUnauthorized: false } : false);

const pool = new Pool({ connectionString: connStr, ssl });

module.exports = pool;
