// routes/sales.js
const express = require('express');
const router = express.Router();

const { authRequired, loadActiveBusiness } = require('../middleware/authMiddleware');
const forbidAppAdmin = require('../middleware/forbidAppAdmin');
const { requireBusinessAccess } = require('../middleware/requireBusinessAccess');

const { ensureInitialBackfillOnce, runDailyAuto } = require('../services/salesSyncPolicy');
const { fetchSalesRanged } = require('../services/maxiSalesService');
const { upsertSalesBatch } = require('../services/salesStore');

// Normaliza businessId desde :id o header/query y valida acceso
const requireBiz = (req, res, next) => requireBusinessAccess(req, res, next);

/**
 * POST /businesses/:id/sync-sales
 * Query:
 *  - mode=init | auto | range
 *  - from=YYYY-MM-DD (si mode=range)
 *  - to=YYYY-MM-DD   (si mode=range)
 */
router.post(
  '/businesses/:id/sync-sales',
  authRequired,
  forbidAppAdmin,
  loadActiveBusiness,
  requireBiz,
  async (req, res) => {
    try {
      const businessId = Number(req.params.id);
      const mode = String(req.query.mode || 'auto').toLowerCase();

      if (!businessId) {
        return res.status(400).json({ error: 'businessId inválido' });
      }

      if (mode === 'init') {
        const out = await ensureInitialBackfillOnce({ businessId, req });
        return res.json({ ok: true, mode, ...out });
      }

      if (mode === 'auto') {
        const out = await runDailyAuto({ businessId, req });
        return res.json({ ok: true, mode, ...out });
      }

      if (mode === 'range') {
        const from = String(req.query.from || '').slice(0, 10);
        const to   = String(req.query.to   || '').slice(0, 10);
        if (!from || !to) {
          return res.status(400).json({ error: 'from/to requeridos (YYYY-MM-DD)' });
        }
        const raw = await fetchSalesRanged({ businessId, from, to, req });
        const up  = await upsertSalesBatch(businessId, raw);
        return res.json({ ok: true, mode, from, to, sales: up });
      }

      return res.status(400).json({ error: `mode inválido: ${mode}` });
    } catch (e) {
      return res.status(e.status || 500).json({ error: 'sync_failed', message: e?.message });
    }
  }
);

/**
 * POST /businesses/:id/sync-sales-7d
 * Atajo: últimos 7 días **hasta AYER**
 */
router.post(
  '/businesses/:id/sync-sales-7d',
  authRequired,
  forbidAppAdmin,
  loadActiveBusiness,
  requireBiz,
  async (req, res) => {
    try {
      const businessId = Number(req.params.id);
      if (!businessId) return res.status(400).json({ error: 'businessId inválido' });

      // últimos 7 días hasta AYER (en UTC)
      const now = new Date();
      const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())); // hoy 00:00 UTC
      end.setUTCDate(end.getUTCDate() - 1); // AYER
      const start = new Date(end);
      start.setUTCDate(start.getUTCDate() - 6);

      const pad2 = (n) => String(n).padStart(2, '0');
      const toISO = (d) => `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;

      const from = toISO(start);
      const to   = toISO(end);

      const raw = await fetchSalesRanged({ businessId, from, to, req });
      const up  = await upsertSalesBatch(businessId, raw);

      return res.json({ ok: true, mode: '7d', from, to, sales: up });
    } catch (e) {
      return res.status(e.status || 500).json({ error: 'sync_7d_failed', message: e?.message });
    }
  }
);

module.exports = router;
