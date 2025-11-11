/* eslint-disable no-console */
// controllers/salesSyncController.js
const { runWindow, runDailyAuto, ensureInitialBackfillOnce } = require('../services/salesSyncPolicy');
const { decryptSecretCompat } = require('../utils/cryptoField');

const fetchNative =
  (typeof globalThis.fetch === 'function')
    ? ((...args) => globalThis.fetch(...args))
    : require('node-fetch');

const BASE = (process.env.MAXI_BASE_URL || 'https://api-mconn.maxisistemas.com.ar').replace(/\/+$/, '');
const FETCH_TIMEOUT_MS = Number(process.env.MAXI_FETCH_TIMEOUT_MS || 30000);
const FETCH_RETRIES    = Number(process.env.MAXI_FETCH_RETRIES || 2);

function parseDate(zd) {
  if (!zd) return null;
  const d = new Date(String(zd));
  return Number.isNaN(+d) ? null : d;
}
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

async function fetchWithRetry(url, options = {}, { retries = FETCH_RETRIES, timeout = FETCH_TIMEOUT_MS } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort('timeout'), timeout);
    try {
      const res = await fetchNative(url, { ...options, signal: ctrl.signal });
      clearTimeout(t);
      if (res.ok) return res;
      if ([429, 500, 502, 503, 504].includes(res.status) && attempt < retries) {
        const delay = 200 * (attempt + 1) ** 2;
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      const body = await res.text().catch(() => '');
      const err = new Error(`HTTP ${res.status} - ${body.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    } catch (e) {
      clearTimeout(t);
      lastErr = e;
      if (attempt < retries) {
        const delay = 200 * (attempt + 1) ** 2;
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr || new Error('fetchWithRetry unknown error');
}

/* Credenciales Maxi desde req.business */
function getMaxiCreds(biz) {
  const props = biz?.props || {};
  const mx = props.maxi || props.maxi_credentials || {};
  const email = mx.email || mx.user || null;
  const codcli = mx.codcli || mx.codigo || null;
  const secret =
    mx.pass_enc ??
    mx.password_enc ??
    mx.password ??
    mx.pass ??
    null;
  const pass = decryptSecretCompat(secret);
  if (!email || !pass || !codcli) {
    const err = new Error('missing_maxi_credentials'); err.status = 400; throw err;
  }
  return { email, pass, codcli };
}

/* ────────────── PING (diagnóstico credenciales Maxi) ────────────── */
// GET /api/businesses/:id/maxi-ping
exports.maxiPing = async (req, res) => {
  const biz = req.business;
  if (!biz?.id) return res.status(400).json({ error: 'no_active_business' });

  try {
    const { email, pass, codcli } = getMaxiCreds(biz);
    const url = `${BASE}/login`;
    const payload = { email, pass, cod_cli: String(codcli) };

    const r = await fetchWithRetry(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await r.json().catch(() => ({}));
    const ok = data?.resultCode === 'SUCCESS' && data?.content?.tokenAccess;
    if (!ok) {
      return res.status(502).json({ ok: false, error: 'login_failed', detail: data?.resultDescription || 'unknown' });
    }
    return res.json({ ok: true, business_id: biz.id, token_preview: String(data.content.tokenAccess).slice(0, 12) + '…' });
  } catch (e) {
    const status = e.status || 500;
    return res.status(status).json({ ok: false, error: e.message || 'ping_failed' });
  }
};

/* ────────────── Sync ventas (auto/range/window/backfill) ────────────── */
// POST /api/businesses/:id/sync-sales  (oficial)
// Body:
//   mode: 'auto' | 'window' | 'range' | 'backfill_30d'  (default 'auto')
//   windowDays: number (1..30)   ← para 'window'
//   from: 'YYYY-MM-DD', to: 'YYYY-MM-DD'  ← para 'range'
exports.syncSalesForBusiness = async (req, res) => {
  const biz = req.business;
  if (!biz?.id) return res.status(400).json({ error: 'no_active_business' });

  const mode = String(req.body?.mode || 'auto').toLowerCase();

  try {
    if (mode === 'auto') {
      const detail = await runDailyAuto({ businessId: biz.id, req });
      return res.json({ ok: true, mode, business_id: biz.id, detail });
    }

    if (mode === 'window') {
      const windowDays = clamp(parseInt(req.body?.windowDays ?? '7', 10) || 7, 1, 30);
      const detail = await runWindow({ businessId: biz.id, days: windowDays, req });
      return res.json({ ok: true, mode, business_id: biz.id, window_days: windowDays, detail });
    }

    if (mode === 'backfill_30d') {
      const detail = await ensureInitialBackfillOnce({ businessId: biz.id, windowDays: 30, req });
      return res.json({ ok: true, mode, business_id: biz.id, detail });
    }

    if (mode === 'range') {
      const from = parseDate(req.body?.from);
      const to   = parseDate(req.body?.to);
      if (!from || !to || to < from) {
        return res.status(400).json({ ok: false, error: 'invalid_range', detail: 'from/to requeridos y to>=from' });
      }
      const diffDays = clamp(Math.ceil((to - from) / (1000 * 60 * 60 * 24)) + 1, 1, 30);
      const detail = await runWindow({ businessId: biz.id, days: diffDays, req });
      return res.json({ ok: true, mode, business_id: biz.id, inferred_window_days: diffDays, detail });
    }

    return res.status(400).json({ ok: false, error: 'invalid_mode' });
  } catch (e) {
    const status = e.status || 500;
    return res.status(status).json({ ok: false, error: e.message || 'sync_failed' });
  }
};
