// routes/syncRoutes.js
const express = require('express');
const router = express.Router({ mergeParams: true });

const { detectInsumosChanges } = require('../services/syncInsumosDetectService');
const { applyInsumosChangeSet } = require('../services/syncChangeSetApplyService');

const db = require('../config/db');

// Helpers auth
const getUserId = (req) => req.user?.id || 1;

// ✅ Soporta ambos montajes:
// - app.use('/api/businesses/:businessId', syncRoutes)
// - router.use('/:id/sync', syncRoutes)
const getBusinessIdParam = (req) => {
  const bid = Number(req.params.businessId ?? req.params.id);
  if (!Number.isFinite(bid) || bid <= 0) return NaN;
  return bid;
};

/* ========================= INSUMOS ========================= */

// Detect insumos
router.post('/insumos/detect', async (req, res, next) => {
  try {
    const businessId = getBusinessIdParam(req);
    if (!Number.isFinite(businessId)) {
      return res.status(400).json({ ok: false, error: 'invalid_business_id' });
    }

    const userId = getUserId(req);
    const out = await detectInsumosChanges({ businessId, userId, req });
    res.json(out);
  } catch (e) { next(e); }
});

/* ========================= CHANGE SETS ========================= */

// List change sets
router.get('/change-sets', async (req, res, next) => {
  try {
    const businessId = getBusinessIdParam(req);
    if (!Number.isFinite(businessId)) {
      return res.status(400).json({ ok: false, error: 'invalid_business_id' });
    }

    const status = req.query.status || null;
    const scope = req.query.scope || null;

    const params = [businessId];
    let w = 'WHERE business_id = $1';
    if (status) { params.push(status); w += ` AND status = $${params.length}`; }
    if (scope) { params.push(scope); w += ` AND scope = $${params.length}`; }

    const { rows } = await db.query(`
      SELECT id, scope, status, summary, created_at, approved_at, applied_at
      FROM sync_change_sets
      ${w}
      ORDER BY created_at DESC
      LIMIT 50
    `, params);

    res.json({ ok: true, rows });
  } catch (e) { next(e); }
});

// Get details
router.get('/change-sets/:changeSetId', async (req, res, next) => {
  try {
    const businessId = getBusinessIdParam(req);
    if (!Number.isFinite(businessId)) {
      return res.status(400).json({ ok: false, error: 'invalid_business_id' });
    }

    const changeSetId = Number(req.params.changeSetId);
    if (!Number.isFinite(changeSetId) || changeSetId <= 0) {
      return res.status(400).json({ ok: false, error: 'invalid_change_set_id' });
    }

    const { rows } = await db.query(`
      SELECT *
      FROM sync_change_sets
      WHERE id = $1 AND business_id = $2
      LIMIT 1
    `, [changeSetId, businessId]);

    res.json({ ok: true, item: rows[0] || null });
  } catch (e) { next(e); }
});

// Approve
router.post('/change-sets/:changeSetId/approve', async (req, res, next) => {
  try {
    const businessId = getBusinessIdParam(req);
    if (!Number.isFinite(businessId)) {
      return res.status(400).json({ ok: false, error: 'invalid_business_id' });
    }

    const changeSetId = Number(req.params.changeSetId);
    if (!Number.isFinite(changeSetId) || changeSetId <= 0) {
      return res.status(400).json({ ok: false, error: 'invalid_change_set_id' });
    }

    const userId = getUserId(req);

    const r = await db.query(`
      UPDATE sync_change_sets
      SET status='approved', approved_by=$3, approved_at=now()
      WHERE id=$1 AND business_id=$2 AND status IN ('pending','error')
    `, [changeSetId, businessId, userId]);

    if ((r.rowCount || 0) === 0) {
      return res.status(404).json({ ok: false, error: 'change_set_not_found_or_not_approvable' });
    }

    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Reject
router.post('/change-sets/:changeSetId/reject', async (req, res, next) => {
  try {
    const businessId = getBusinessIdParam(req);
    if (!Number.isFinite(businessId)) {
      return res.status(400).json({ ok: false, error: 'invalid_business_id' });
    }

    const changeSetId = Number(req.params.changeSetId);
    if (!Number.isFinite(changeSetId) || changeSetId <= 0) {
      return res.status(400).json({ ok: false, error: 'invalid_change_set_id' });
    }

    const userId = getUserId(req);

    const r = await db.query(`
      UPDATE sync_change_sets
      SET status='rejected', approved_by=$3, approved_at=now()
      WHERE id=$1 AND business_id=$2 AND status IN ('pending','error')
    `, [changeSetId, businessId, userId]);

    if ((r.rowCount || 0) === 0) {
      return res.status(404).json({ ok: false, error: 'change_set_not_found_or_not_rejectable' });
    }

    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Apply
router.post('/change-sets/:changeSetId/apply', async (req, res, next) => {
  try {
    const businessId = getBusinessIdParam(req);
    if (!Number.isFinite(businessId)) {
      return res.status(400).json({ ok: false, error: 'invalid_business_id' });
    }

    const changeSetId = Number(req.params.changeSetId);
    if (!Number.isFinite(changeSetId) || changeSetId <= 0) {
      return res.status(400).json({ ok: false, error: 'invalid_change_set_id' });
    }

    const userId = getUserId(req);
    const out = await applyInsumosChangeSet({ businessId, changeSetId, userId });
    res.json(out);
  } catch (e) { next(e); }
});

module.exports = router;
