// services/salesSyncPolicy.js
const pool = require('../config/db');
const { fetchSalesRanged } = require('./maxiSalesService');
const { upsertSalesBatch } = require('./salesStore');

// ---- advisory lock por negocio ----
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

// ---- helpers fecha (hasta AYER) ----
function pad2(n){ return String(n).padStart(2,'0'); }
function toISODate(d){ return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`; }

function lastNDaysUntilYesterday(N = 7) {
  const now = new Date();
  const end = new Date(now); end.setDate(end.getDate() - 1); // AYER
  const start = new Date(end); start.setDate(start.getDate() - (N - 1));
  return { from: toISODate(start), to: toISODate(end) };
}
const INIT_BACKFILL_DAYS = Math.max(1, Number(process.env.INIT_BACKFILL_DAYS || 7));

// ---- estado persistente (sales_sync_state) ----
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
  const q1 = `SELECT MAX(day) AS max_day FROM sales_daily WHERE business_id=$1`;
  const r1 = await client.query(q1, [businessId]);
  if (r1.rows[0]?.max_day) return r1.rows[0].max_day;

  const q2 = `SELECT MAX(DATE(occurred_at)) AS max_day FROM app_sales WHERE business_id=$1`;
  const r2 = await client.query(q2, [businessId]);
  return r2.rows[0]?.max_day || null;
}

// ====== API pública ======

/**
 * Backfill inicial UNA SOLA VEZ.
 * windowDays: tamaño de ventana (default: env INITIAL_BACKFILL_DAYS || 7)
 */
/** Backfill inicial UNA SOLA VEZ (N días hasta ayer) */
async function ensureInitialBackfillOnce({ businessId, req }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (!(await tryLock(client, businessId))) {
      await client.query('ROLLBACK'); client.release();
      return { ok: false, skipped: true, reason: 'locked' };
    }

    const state = await readState(client, businessId);
    if (state?.initial_backfill_done) {
      await unlock(client, businessId);
      await client.query('COMMIT'); client.release();
      return { ok: true, already_done: true };
    }

    const { from, to } = lastNDaysUntilYesterday(INIT_BACKFILL_DAYS);
    const raw = await fetchSalesRanged({ businessId, from, to, req });
    const res = await upsertSalesBatch(businessId, raw);

    await upsertState(client, businessId, {
      initial_backfill_done: true,
      initial_backfill_at: new Date(),
      last_daily_sync_at: to
    });

    await unlock(client, businessId);
    await client.query('COMMIT'); client.release();
    return { ok: true, from, to, window_days: INIT_BACKFILL_DAYS, ...res };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    try { await unlock(client, businessId); } catch {}
    client.release();
    e.status = e.status || 500;
    throw e;
  }
}

/**
 * Incremental diario (desde último día + 1 hasta AYER).
 * No necesita windowDays; usa lo que falte desde la DB.
 */
async function runDailyAuto({ businessId, req }) {
  const client = await pool.connect();
  let locked = false;
  try {
    await client.query('BEGIN');

    locked = await tryLock(client, businessId);
    if (!locked) {
      await client.query('ROLLBACK');
      return { ok: false, skipped: true, reason: 'locked' };
    }

    const state = await readState(client, businessId);
    if (!state?.initial_backfill_done) {
      await client.query('COMMIT'); // libero trx antes de delegar
      // NOTA: no hace falta mantener lock para el backfill
      return await ensureInitialBackfillOnce({ businessId, req });
    }

    const maxDay = await getMaxDayFromDB(client, businessId);
    const y = lastNUntilYesterday(1).to; // AYER
    if (!maxDay) {
      await client.query('COMMIT');
      return await ensureInitialBackfillOnce({ businessId, req });
    }

    const start = new Date(maxDay); start.setDate(start.getDate() + 1);
    const from = toISODate(start), to = y;
    if (from > to) {
      await upsertState(client, businessId, { last_daily_sync_at: to });
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
    try { if (locked) await unlock(client, businessId); } catch {}
    client.release(); // ← liberar UNA vez
  }

  console.log(`[sync] biz=${businessId} intento lock...`);
locked = await tryLock(client, businessId);
console.log(`[sync] biz=${businessId} locked=${locked}`);

}


module.exports = { ensureInitialBackfillOnce, runDailyAuto };
