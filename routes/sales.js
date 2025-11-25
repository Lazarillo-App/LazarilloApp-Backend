// routes/sales.js  (LEGACY / alias a salesSyncController)
const express = require('express');
const router = express.Router();

const { authRequired, loadActiveBusiness } = require('../middleware/authMiddleware');
const forbidAppAdmin = require('../middleware/forbidAppAdmin');
const { requireBusinessAccess } = require('../middleware/requireBusinessAccess');

const salesSync = require('../controllers/salesSyncController');

const requireBiz = (req, res, next) => requireBusinessAccess(req, res, next);

/**
 * LEGACY:
 * POST /businesses/:id/sync-sales?mode=init|auto|range&from&to
 * Redirige internamente a salesSync.syncSalesForBusiness
 */
router.post(
  '/businesses/:id/sync-sales',
  authRequired,
  forbidAppAdmin,
  loadActiveBusiness,
  requireBiz,
  async (req, res, next) => {
    try {
      const biz = req.business;

      const modeQuery = String(req.query.mode || 'auto').toLowerCase();
      const body = {};

      if (modeQuery === 'init') {
        body.mode = 'backfill_30d';      // equivalente a backfill inicial
      } else if (modeQuery === 'range') {
        body.mode = 'window';
        body.from = String(req.query.from || '').slice(0, 10);
        body.to   = String(req.query.to   || '').slice(0, 10);
      } else {
        body.mode = 'auto';
      }

      const out = await salesSync.syncSalesForBusiness(biz, body, req);
      res.json({ ok: true, business_id: biz.id, sales: out });
    } catch (e) {
      next(e);
    }
  }
);

/**
 * LEGACY:
 * POST /businesses/:id/sync-sales-7d
 * Alias: modo auto con ventana 7d (la policy decide cómo recortar a AYER).
 */
router.post(
  '/businesses/:id/sync-sales-7d',
  authRequired,
  forbidAppAdmin,
  loadActiveBusiness,
  requireBiz,
  async (req, res, next) => {
    try {
      const biz = req.business;
      const body = { mode: 'auto', windowDays: 7 };
      const out = await salesSync.syncSalesForBusiness(biz, body, req);
      res.json({ ok: true, business_id: biz.id, sales: out });
    } catch (e) {
      next(e);
    }
  }
);

module.exports = router;
