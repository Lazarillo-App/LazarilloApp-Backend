/* eslint-disable no-console */
'use strict';

const { fetchSalesRanged } = require('../services/maxiSalesService');
const { upsertSalesBatch, upsertDailyAggregates } = require('../services/salesStore');
const { ensureInitialBackfillOnce, runDailyAuto, runWindow } = require('../services/salesSyncPolicy');

/* PROBE de facturación (no escribe DB) */
exports.maxiInvoiceProbe = async (req, res) => {
  try {
    const biz = req.business;
    const from = String(req.query.from || '').slice(0,10);
    const to   = String(req.query.to   || '').slice(0,10);
    if (!from || !to) return res.status(400).json({ error: 'from_to_required' });

    const docs = await fetchSalesRanged({ businessId: biz.id, from, to, req });
    return res.json({ ok: true, business_id: biz.id, from, to, docs: docs.slice(0,3), count: docs.length });
  } catch (e) {
    console.error('maxiInvoiceProbe', e);
    return res.status(e.status || 500).json({ ok: false, error: e.message || 'probe_failed' });
  }
};

/* Ejecuta una ventana puntual (escribe DB) */
exports.syncWindow = async (req, res) => {
  try {
    const biz = req.business;
    const from = String(req.body?.from || req.query?.from || '').slice(0,10);
    const to   = String(req.body?.to   || req.query?.to   || '').slice(0,10);
    if (!from || !to) return res.status(400).json({ error: 'from_to_required' });

    const raw = await fetchSalesRanged({ businessId: biz.id, from, to, req });
    const out = await upsertSalesBatch(biz.id, raw);
    return res.json({ ok: true, business_id: biz.id, from, to, fetched: raw.length, ...out });
  } catch (e) {
    console.error('syncWindow', e);
    return res.status(e.status || 500).json({ ok: false, error: e.message || 'sync_window_failed' });
  }
};

/* Backfill inicial (una vez) */
exports.syncBackfillOnce = async (req, res) => {
  try {
    const biz = req.business;
    const out = await ensureInitialBackfillOnce({ businessId: biz.id, req });
    return res.json({ ok: true, business_id: biz.id, ...out });
  } catch (e) {
    console.error('syncBackfillOnce', e);
    return res.status(e.status || 500).json({ ok: false, error: e.message || 'backfill_failed' });
  }
};

/* Incremental diario automático */
exports.syncDailyAuto = async (req, res) => {
  try {
    const biz = req.business;
    const out = await runDailyAuto({ businessId: biz.id, req });
    return res.json({ ok: true, business_id: biz.id, ...out });
  } catch (e) {
    console.error('syncDailyAuto', e);
    return res.status(e.status || 500).json({ ok: false, error: e.message || 'daily_auto_failed' });
  }
};

/* Recalcular agregados (si cambiaste mapeos, etc.) */
exports.rebuildAggregates = async (req, res) => {
  try {
    const biz = req.business;
    const from = String(req.body?.from || req.query?.from || '').slice(0,10);
    const to   = String(req.body?.to   || req.query?.to   || '').slice(0,10);
    if (!from || !to) return res.status(400).json({ error: 'from_to_required' });

    await upsertDailyAggregates(biz.id, from, to);
    return res.json({ ok: true, business_id: biz.id, from, to, rebuilt: true });
  } catch (e) {
    console.error('rebuildAggregates', e);
    return res.status(e.status || 500).json({ ok: false, error: e.message || 'rebuild_failed' });
  }
};

/* ── Alias por compatibilidad con rutas antiguas ─────────────────── */
exports.maxiSalesProbeV2 = exports.maxiInvoiceProbe;
exports.adminSyncSalesWindow = exports.syncWindow;
