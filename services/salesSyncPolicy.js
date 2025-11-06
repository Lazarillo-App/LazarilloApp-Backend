// services/salesSyncPolicy.js
const pool = require('../config/db');
const { fetchSalesRanged } = require('./maxiSalesService');
const { upsertSalesBatch } = require('./salesStore');

function lockKeyFor(businessId) { return 0x53A1E5 ^ Number(businessId); }
async function tryLock(client, businessId) {
  const { rows: [{ locked }] } = await client.query(
    'SELECT pg_try_advisory_lock($1) AS locked', [lockKeyFor(businessId)]
  );
  return !!locked;
}
async function unlock(client, businessId) {
  await client.query('SELECT pg_advisory_unlock($1)', [lockKeyFor(businessId)]);
}

function pad2(n){ return String(n).padStart(2,'0'); }
function toISODate(d){ return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`; }
function last30UntilYesterday() {
  const now = new Date();
  const end = new Date(now); end.setDate(end.getDate() - 1);
  const start = new Date(end); start.setDate(start.getDate() - 29);
  return { from: toISODate(start), to: toISODate(end) };
}

async function readState(client, businessId) {
  const { rows } = await client.query(
    'SELECT * FROM sales_sync_state WHERE business_id=$1', [businessId]
  );
  return rows[0] || null;
}
async function upsertState(client, businessId, patch) {
  const keys = Object.keys(patch);
  const cols = ['business_id', ...keys];
  const vals = [businessId, ...keys.map(k => patch[k])];
  const params = vals.map((_,i)=>`$${i+1}`).join(', ');
  const updates = keys.map(k => `${k}=EXCLUDED.${k}`).join(', ');
  const sql = `INSERT INTO sales_sync_state (${cols.join(',')})
               VALUES (${params})
               ON CONFLICT (business_id) DO UPDATE SET ${updates}
               RETURNING *`;
  const { rows } = await client.query(sql, vals);
  return rows[0];
}

async function getMaxDayFromDB(client, businessId) {
  const r1 = await client.query(
    `SELECT MAX(day) AS max_day FROM sales_daily WHERE business_id=$1`, [businessId]
  );
  if (r1.rows[0]?.max_day) return r1.rows[0].max_day;

  const r2 = await client.query(
    `SELECT MAX(DATE(occurred_at)) AS max_day FROM app_sales WHERE business_id=$1`, [businessId]
  );
  return r2.rows[0]?.max_day || null;
}

/** Backfill inicial UNA SOLA VEZ (30 días hasta ayer) — release único en finally */
async function ensureInitialBackfillOnce({ businessId, req }) {
  const client = await pool.connect();
  let haveLock = false;
  try {
    await client.query('BEGIN');

    haveLock = await tryLock(client, businessId);
    if (!haveLock) {
      await client.query('ROLLBACK');
      return { ok: false, skipped: true, reason: 'locked' };
    }

    const state = await readState(client, businessId);
    if (state?.initial_backfill_done) {
      await client.query('COMMIT');
      return { ok: true, already_done: true };
    }

    const { from, to } = last30UntilYesterday();
    const raw = await fetchSalesRanged({ businessId, from, to, req });
    const res = await upsertSalesBatch(businessId, raw);

    await upsertState(client, businessId, {
      initial_backfill_done: true,
      initial_backfill_at: new Date(),
      last_daily_sync_at: to
    });

    await client.query('COMMIT');
    return { ok: true, from, to, ...res };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    e.status = e.status || 500;
    throw e;
  } finally {
    // desbloquear si lo tomamos, y SIEMPRE liberar UNA vez
    try { if (haveLock) await unlock(client, businessId); } catch {}
    try { client.release(); } catch {}
  }
}

/** Incremental diario (desde último día + 1 hasta ayer) — release único en finally */
async function runDailyAuto({ businessId, req }) {
  const client = await pool.connect();
  let haveLock = false;
  try {
    await client.query('BEGIN');

    haveLock = await tryLock(client, businessId);
    if (!haveLock) {
      await client.query('ROLLBACK');
      return { ok: false, skipped: true, reason: 'locked' };
    }

    const state = await readState(client, businessId);
    if (!state?.initial_backfill_done) {
      await client.query('COMMIT');
      // no usamos el client aquí (otra conexión por dentro)
      return await ensureInitialBackfillOnce({ businessId, req });
    }

    const maxDay = await getMaxDayFromDB(client, businessId);
    const y = last30UntilYesterday().to;

    if (!maxDay) {
      await client.query('COMMIT');
      return await ensureInitialBackfillOnce({ businessId, req });
    }

    const start = new Date(maxDay); start.setDate(start.getDate() + 1);
    const from = toISODate(start), to = y;

    if (from > to) {
      await client.query('COMMIT');
      return { ok: true, up_to_date: true, last_day: maxDay };
    }

    const raw = await fetchSalesRanged({ businessId, from, to, req });
    const res = await upsertSalesBatch(businessId, raw);
    await upsertState(client, businessId, { last_daily_sync_at: to });

    await client.query('COMMIT');
    return { ok: true, from, to, ...res };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    e.status = e.status || 500;
    throw e;
  } finally {
    try { if (haveLock) await unlock(client, businessId); } catch {}
    try { client.release(); } catch {}
  }
}

module.exports = { ensureInitialBackfillOnce, runDailyAuto };
