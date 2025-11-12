/* eslint-disable no-console */
'use strict';

const pool = require('../config/db');
const { getBearer, fetchSalesRanged } = require('../services/maxiSalesService');
const { upsertSalesBatch, upsertDailyAggregates } = require('../services/salesStore');
const { ensureInitialBackfillOnce, runDailyAuto } = require('../services/salesSyncPolicy');

/* ───────── helpers fecha ───────── */
const pad2 = (n) => String(n).padStart(2,'0');
const ymd  = (d) => `${d.getUTCFullYear()}-${pad2(d.getUTCMonth()+1)}-${pad2(d.getUTCDate())}`;
const at00 = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const addDaysUTC = (d, n) => new Date(d.getTime() + n*86400000);

function parseDate(zd, fb) {
  if (!zd) return fb;
  const d = new Date(zd);
  return Number.isNaN(+d) ? fb : d;
}
function clampToYesterday(a, b) {
  const today = new Date();
  const AYER  = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 1));
  return { from: a, to: b > AYER ? AYER : b };
}

/* ===================== Handlers ===================== */

/** GET /api/businesses/:id/maxi-ping */
exports.maxiPing = async (req, res) => {
  try {
    const biz = req.business;
    // Si hay credenciales en DB o header X-Maxi-Token, esto devuelve token válido o lanza
    const token = await getBearer(biz.id, req);
    const props = biz?.props || {};
    const mx = props.maxi || props.maxi_credentials || {};
    return res.json({
      ok: true,
      configured: !!(mx?.email && (mx?.codcli || mx?.cod_cli)),
      connected: !!token,
      email: mx?.email || null,
      codcli: mx?.codcli || mx?.cod_cli || null,
    });
  } catch (e) {
    return res.json({ ok: false, configured: false, connected: false, error: e.message || 'ping_failed' });
  }
};

/** POST /api/businesses/:id/sync-sales/window  body: { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD', dryrun?: boolean } */
exports.syncWindow = async (req, res) => {
  try {
    const biz = req.business;
    const { from, to, dryrun = false } = req.body || {};
    if (!from || !to) return res.status(400).json({ error: 'from_to_required' });

    // clamp hasta AYER
    const defFrom = new Date(`${from}T00:00:00Z`);
    const defTo   = new Date(`${to}T00:00:00Z`);
    const { from: Fd, to: Td } = clampToYesterday(defFrom, defTo);
    const F = ymd(Fd), T = ymd(Td);

    // 1) Traer desde Maxi por ventanas (services/maxiSalesService)
    const rawDocs = await fetchSalesRanged({ businessId: biz.id, from: F, to: T, req });

    if (dryrun) {
      return res.json({ ok: true, business_id: String(biz.id), from: F, to: T, upserted: 0, updated: 0, preview: rawDocs.slice(0, 3) });
    }

    // 2) Upsert completo de tickets+líneas y agregados tocados
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await upsertSalesBatch(biz.id, rawDocs, client);
      await client.query('COMMIT');
      return res.json({ ok: true, business_id: String(biz.id), from: F, to: T, ...result });
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch {}
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    console.error('syncWindow error:', e);
    return res.status(e.status || 500).json({ error: 'internal', message: e.message || 'sync_window_failed' });
  }
};

/** POST /api/businesses/:id/sync-sales/backfill-once */
exports.backfillOnce = async (req, res) => {
  try {
    const biz = req.business;
    const out = await ensureInitialBackfillOnce({ businessId: biz.id, req });
    return res.json({ ok: true, business_id: String(biz.id), ...out });
  } catch (e) {
    return res.status(e.status || 500).json({ ok: false, error: e.message || 'backfill_failed' });
  }
};

/** POST /api/businesses/:id/sync-sales/daily-auto */
exports.dailyAuto = async (req, res) => {
  try {
    const biz = req.business;
    const out = await runDailyAuto({ businessId: biz.id, req });
    return res.json({ ok: true, business_id: String(biz.id), ...out });
  } catch (e) {
    return res.status(e.status || 500).json({ ok: false, error: e.message || 'daily_auto_failed' });
  }
};

/** POST /api/businesses/:id/sync-sales/rebuild-aggregates  body: { from, to } */
exports.rebuildAggregates = async (req, res) => {
  try {
    const biz = req.business;
    const F = String(req.body?.from || req.query?.from || '').slice(0,10);
    const T = String(req.body?.to   || req.query?.to   || '').slice(0,10);
    if (!F || !T) return res.status(400).json({ ok: false, error: 'from_to_required' });

    await upsertDailyAggregates(biz.id, F, T);
    return res.json({ ok: true, business_id: String(biz.id), from: F, to: T, rebuilt: true });
  } catch (e) {
    return res.status(e.status || 500).json({ ok: false, error: e.message || 'rebuild_failed' });
  }
};
