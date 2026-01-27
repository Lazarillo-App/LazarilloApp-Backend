// routes/syncRoutes.js
const express = require('express');
const router = express.Router({ mergeParams: true });

const { detectInsumosChanges } = require('../services/syncInsumosDetectService');
const { applyInsumosChangeSet } = require('../services/syncChangeSetApplyService');

// Helpers auth (ajustá a tu proyecto)
const getUserId = (req) => req.user?.id || 1;

// Detect insumos
router.post('/insumos/detect', async (req, res, next) => {
  try {
    const businessId = Number(req.params.businessId);
    const userId = getUserId(req);
    const out = await detectInsumosChanges({ businessId, userId, req });
    res.json(out);
  } catch (e) { next(e); }
});

// List change sets
router.get('/change-sets', async (req, res, next) => {
  try {
    const businessId = Number(req.params.businessId);
    const status = req.query.status || null;
    const scope = req.query.scope || null;

    const params = [businessId];
    let w = 'WHERE business_id = $1';
    if (status) { params.push(status); w += ` AND status = $${params.length}`; }
    if (scope) { params.push(scope); w += ` AND scope = $${params.length}`; }

    const { rows } = await require('../config/db').query(`
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
router.get('/change-sets/:id', async (req, res, next) => {
  try {
    const businessId = Number(req.params.businessId);
    const id = Number(req.params.id);
    const { rows } = await require('../config/db').query(`
      SELECT *
      FROM sync_change_sets
      WHERE id = $1 AND business_id = $2
      LIMIT 1
    `, [id, businessId]);

    res.json({ ok: true, item: rows[0] || null });
  } catch (e) { next(e); }
});

// Approve
router.post('/change-sets/:id/approve', async (req, res, next) => {
  try {
    const businessId = Number(req.params.id);
    const id = Number(req.params.id);
    const userId = getUserId(req);

    await require('../config/db').query(`
      UPDATE sync_change_sets
      SET status='approved', approved_by=$3, approved_at=now()
      WHERE id=$1 AND business_id=$2 AND status IN ('pending','error')
    `, [id, businessId, userId]);

    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Reject
router.post('/change-sets/:id/reject', async (req, res, next) => {
  try {
    const businessId = Number(req.params.businessId);
    const id = Number(req.params.id);
    const userId = getUserId(req);

    await require('../config/db').query(`
      UPDATE sync_change_sets
      SET status='rejected', approved_by=$3, approved_at=now()
      WHERE id=$1 AND business_id=$2 AND status IN ('pending','error')
    `, [id, businessId, userId]);

    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Apply
router.post('/change-sets/:id/apply', async (req, res, next) => {
  try {
    const businessId = Number(req.params.businessId);
    const id = Number(req.params.id);
    const userId = getUserId(req);

    const out = await applyInsumosChangeSet({ businessId, changeSetId: id, userId });
    res.json(out);
  } catch (e) { next(e); }
});

module.exports = router;
