// services/salesSyncPolicy.js
'use strict';

const pool = require('../config/db');
const { fetchSalesRanged } = require('./maxiSalesService');
const { upsertSalesBatch } = require('./salesStore');

/* ───────────────────── Advisory lock por negocio ───────────────────── */
function lockKeyFor(businessId) { return 0x53A1E5 ^ Number(businessId); }

async function tryLock(client, businessId) {
  const { rows: [{ locked }] } = await client.query(
    'SELECT pg_try_advisory_lock($1) AS locked',
    [lockKeyFor(businessId)]
  );
  return !!locked;
}

async function unlock(client, businessId) {
  await client.query('SELECT pg_advisory_unlock($1)', [lockKeyFor(businessId)]);
}

/* ───────────────────── Helpers de fechas (hasta AYER) ───────────────────── */
const pad2 = (n) => String(n).padStart(2, '0');
const toISODate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const at00 = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const ymd  = (d) => `${d.getUTCFullYear()}-${pad2(d.getUTCMonth()+1)}-${pad2(d.getUTCDate())}`;
const addDaysUTC = (d, n) => new Date(d.getTime() + n*86400000);

function lastNDaysUntilYesterday(N = 7) {
  const now = new Date();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())); // hoy (UTC) 00:00
  end.setUTCDate(end.getUTCDate() - 1); // AYER
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (N - 1));
  return { from: toISODate(start), to: toISODate(end) };
}

function yesterdayISO() {
  const now = new Date();
  const y = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  y.setUTCDate(y.getUTCDate() - 1);
  return toISODate(y);
}

const INIT_BACKFILL_DAYS = Math.max(1, Number(process.env.INIT_BACKFILL_DAYS || 7));

/* ─────────────────────────── Estado persistente ─────────────────────────── */
async function readState(client, businessId) {
  const { rows } = await client.query(
    'SELECT * FROM sales_sync_state WHERE business_id=$1',
    [businessId]
  );
  return rows[0] || null;
}

async function upsertState(client, businessId, patch) {
  const keys = Object.keys(patch);
  if (!keys.length) return null;
  const cols = ['business_id', ...keys];
  const vals = [businessId, ...keys.map(k => patch[k])];
  const params = vals.map((_, i) => `$${i + 1}`).join(', ');
  const updates = keys.map(k => `${k}=EXCLUDED.${k}`).join(', ');
  const sql = `
    INSERT INTO sales_sync_state (${cols.join(', ')})
    VALUES (${params})
    ON CONFLICT (business_id) DO UPDATE SET ${updates}
    RETURNING *`;
  const { rows } = await client.query(sql, vals);
  return rows[0];
}

/* ─────────────────────────── API pública ─────────────────────────── */
/**
 * Ventana explícita: requiere { from, to } (YYYY-MM-DD).
 * Hace fetch → upsert → reconcile → rebuild agregados dentro del rango [from..to].
 */
async function runWindow({ businessId, from, to, req } = {}) {
  if (!businessId) { const e = new Error('businessId requerido'); e.status = 400; throw e; }
  if (!from || !to)  { const e = new Error('from/to requeridos'); e.status = 400; throw e; }

  // Clamp a AYER (UTC) para evitar hoy parcial
  const end = at00(new Date());
  end.setUTCDate(end.getUTCDate() - 1);
  const F = ymd(at00(new Date(from)));
  const T = ymd(new Date(ymd(at00(new Date(to))) > ymd(end) ? end : at00(new Date(to))));

  // 1) Traer crudo desde Maxi
  const raw = await fetchSalesRanged({ businessId, from: F, to: T, req });

  // 2) Upsert completo (ventas + ítems + mapping + agregados diarios)
  const result = await upsertSalesBatch(businessId, raw); // usa su propia transacción

  return { from: F, to: T, fetched: raw.length, ...result };
}

/**
 * Backfill inicial UNA SOLA VEZ (N días hasta AYER).
 * Se usa al crear un negocio o cuando aún no hay backfill inicial hecho.
 */

async function ensureInitialBackfillOnce({ businessId, req, days }) {
  if (!businessId) {
    const e = new Error('businessId requerido');
    e.status = 400;
    throw e;
  }

  // N configurable vía parámetro, sino usa INIT_BACKFILL_DAYS
  const N = Number(days) > 0 ? Number(days) : INIT_BACKFILL_DAYS;

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
    if (state?.initial_backfill_done) {
      await client.query('COMMIT');
      return { ok: true, already_done: true };
    }

    const { from, to } = lastNDaysUntilYesterday(N);

    // Cerramos transacción antes de hablar con Maxi
    await client.query('COMMIT');

    // 1) Traer crudo
    const raw = await fetchSalesRanged({ businessId, from, to, req });

    // 2) Upsert completo (incluye mapping + agregados diarios)
    const res = await upsertSalesBatch(businessId, raw);

    const rFrom = res.minDay || from;
    const rTo   = res.maxDay || to;

    // 3) Actualizar estado de sync
    const c2 = await pool.connect();
    try {
      await c2.query('BEGIN');
      await upsertState(c2, businessId, {
        initial_backfill_done: true,
        initial_backfill_at: new Date(),
        last_daily_sync_at: rTo
      });
      await c2.query('COMMIT');
    } catch (e) {
      try { await c2.query('ROLLBACK'); } catch {}
      throw e;
    } finally {
      c2.release();
    }

    return { ok: true, from, to, window_days: N, ...res };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    e.status = e.status || 500;
    throw e;
  } finally {
    try { if (locked) await unlock(client, businessId); } catch {}
    client.release();
  }
}

/**
 * Incremental diario: desde (último día + 1) hasta AYER.
 * Si nunca hizo backfill inicial, lo dispara primero.
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
      await client.query('COMMIT'); // liberar transacción antes de delegar
      return await ensureInitialBackfillOnce({ businessId, req });
    }

    const maxDay = await getMaxDayFromDB(client, businessId);
    const y = yesterdayISO(); // AYER

    // Si no hay datos aún, hacer backfill inicial
    if (!maxDay) {
      await client.query('COMMIT');
      return await ensureInitialBackfillOnce({ businessId, req });
    }

    // Calcular desde el día siguiente al último día que tenemos
    const start = new Date(maxDay);
    start.setUTCDate(start.getUTCDate() + 1);
    const from = toISODate(start);
    const to = y;

    // Ya al día
    if (from > to) {
      await upsertState(client, businessId, { last_daily_sync_at: to });
      await client.query('COMMIT');
      return { ok: true, up_to_date: true, last_day: maxDay };
    }

    await client.query('COMMIT'); // cerrar antes del fetch externo

    // Traer lo faltante → upsert completo (incluye mapping + agregados)
    const raw = await fetchSalesRanged({ businessId, from, to, req });
    const res = await upsertSalesBatch(businessId, raw);

    const rFrom = res.minDay || from;
    const rTo   = res.maxDay || to;

    // Actualizar estado de sync
    const c2 = await pool.connect();
    try {
      await c2.query('BEGIN');
      await upsertState(c2, businessId, { last_daily_sync_at: rTo });
      await c2.query('COMMIT');
    } catch (e) {
      try { await c2.query('ROLLBACK'); } catch {}
      throw e;
    } finally {
      c2.release();
    }

    return { ok: true, from, to, ...res };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    e.status = e.status || 500;
    throw e;
  } finally {
    try { if (locked) await unlock(client, businessId); } catch {}
    client.release();
  }
}

/** Último día con datos (prefiere agregados; si no, crudos) */
async function getMaxDayFromDB(client, businessId) {
  const r1 = await client.query(
    `SELECT MAX(day) AS max_day FROM sales_daily WHERE business_id=$1`,
    [businessId]
  );
  if (r1.rows[0]?.max_day) return r1.rows[0].max_day;

  const r2 = await client.query(
    `SELECT MAX( (occurred_at AT TIME ZONE 'UTC')::date ) AS max_day
       FROM app_sales WHERE business_id=$1`,
    [businessId]
  );
  return r2.rows[0]?.max_day || null;
}

module.exports = {
  ensureInitialBackfillOnce,
  runDailyAuto,
  runWindow,
};
