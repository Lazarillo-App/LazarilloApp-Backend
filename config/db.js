// config/db.js
require('dotenv').config();
const { Pool } = require('pg');

// -----------------------------
// Construcción de connectionString
// -----------------------------
const connStr =
  process.env.DATABASE_URL ||
  `postgres://${process.env.PGUSER || 'postgres'}:${process.env.PGPASSWORD || ''}` +
  `@${process.env.PGHOST || 'localhost'}:${process.env.PGPORT || 5432}/${process.env.PGDATABASE || 'lazarillo_app'}`;

// -----------------------------
// SSL
// -----------------------------
const sslMode = String(process.env.PGSSLMODE || '').toLowerCase();
const autoSSL = !/localhost|127\.0\.0\.1/i.test(connStr);
const ssl =
  sslMode === 'disable' ? false :
    sslMode === 'require' ? { rejectUnauthorized: false } :
      (autoSSL ? { rejectUnauthorized: false } : false);

// -----------------------------
// Pool options
// -----------------------------
const pool = new Pool({
  connectionString: connStr,
  ssl,
  max: Number(process.env.PGPOOL_MAX || 10),
  idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS || 30_000),
  connectionTimeoutMillis: Number(process.env.PG_CONN_TIMEOUT_MS || 10_000),
  application_name: process.env.PGAPPNAME || 'lazarillo-backend',

  // 👇 evita drops por inactividad y reconexiones molestas
  keepAlive: true,
  keepAliveInitialDelayMillis: Number(process.env.PG_KEEPALIVE_INIT_MS || 5_000),
});

// Set por conexión
pool.on('connect', async (client) => {
  try {
    await client.query(`SET TIME ZONE 'UTC'`);
    if (process.env.PG_STATEMENT_TIMEOUT_MS) {
      const ms = Math.max(0, Number(process.env.PG_STATEMENT_TIMEOUT_MS));
      if (ms) await client.query(`SET statement_timeout TO ${ms}`);
    }
    // 👇 importante para cortar sesiones colgadas en transacciones
    if (process.env.PG_IDLE_TX_TIMEOUT_MS) {
      const ms = Math.max(0, Number(process.env.PG_IDLE_TX_TIMEOUT_MS));
      if (ms) await client.query(`SET idle_in_transaction_session_timeout = '${ms}ms'`);
    }
    if (process.env.PG_SEARCH_PATH) {
      await client.query(`SET search_path TO ${process.env.PG_SEARCH_PATH}`);
    }
  } catch (e) {
    console.warn('[db] connect hook SET failed:', e.message);
  }
});

pool.on('error', (err) => {
  console.error('[db] Pool error:', err);
});

// -----------------------------
// Wrapper de query con “slow log”
// -----------------------------
const SLOW_MS = Number(process.env.DB_SLOW_QUERY_MS || 500);
const origQuery = pool.query.bind(pool);

pool.query = async (text, params) => {
  const start = process.hrtime.bigint();
  try {
    const res = await origQuery(text, params);
    const durMs = Number((process.hrtime.bigint() - start) / 1_000_000n);
    if (durMs >= SLOW_MS) {
      const preview =
        Array.isArray(params) ? params.map((p) => (typeof p === 'string' && p.length > 200 ? p.slice(0, 200) + '…' : p)) : params;
      console.warn(`🐢 [db] slow query (${durMs}ms):`, {
        text: String(text).slice(0, 300),
        params: preview,
      });
    }
    return res;
  } catch (err) {
    console.error('❌ [db] query error:', {
      code: err.code,
      message: err.message,
      text: String(text).slice(0, 300),
    });
    throw err;
  }
}

// -----------------------------
// Graceful shutdown
// -----------------------------
async function shutdown() {
  try {
    await pool.end();
    console.log('🛑 [db] pool cerrado');
    process.exit(0);
  } catch (e) {
    console.error('⚠️ [db] error al cerrar pool:', e.message);
    process.exit(1);
  }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = pool;
