require('dotenv').config();
const { Pool } = require('pg');

const isRender = !!process.env.RENDER || /render\.com/.test(process.env.DATABASE_URL || '');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
    // fallback para local si te olvidás de poner DATABASE_URL
    || `postgres://${process.env.PGUSER || 'postgres'}:${process.env.PGPASSWORD || ''}` +
       `@${process.env.PGHOST || 'localhost'}:${process.env.PGPORT || 5432}/${process.env.PGDATABASE || 'agrupaciones_db'}`,
  ssl: isRender ? { rejectUnauthorized: false } : false
});

module.exports = pool;