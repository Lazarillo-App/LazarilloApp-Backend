// routes/businessRoutes.js
const express = require('express');
const router = express.Router();
const pool = require('../config/db');

const businesses = require('../controllers/businessController');
const {
  listArticlesFromDB,
  listArticlesTreeFromDB,
  salesSummaryFromDB,
  salesSeriesFromDB,
  syncNow,
} = require('../controllers/syncController');

// ventas sync / ping
const { maxiPing, syncSalesForBusiness } = require('../controllers/salesSyncController');

router.param('id', async (req, res, next, id) => {
  try {
    const uid = Number(req.user?.id);
    const bizId = Number(id);
    if (!Number.isFinite(uid) || !Number.isFinite(bizId)) {
      return res.status(400).json({ error: 'invalid_business_id' });
    }
    const { rows } = await pool.query(
      `SELECT b.*
         FROM app_businesses b
        WHERE b.id=$1
          AND (b.owner_id=$2 OR EXISTS (
            SELECT 1 FROM user_businesses ub WHERE ub.business_id=b.id AND ub.user_id=$2
          ))
        LIMIT 1`,
      [bizId, uid]
    );
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    req.businessId = bizId;
    req.business   = rows[0];
    next();
  } catch (e) { next(e); }
});

// Maxi ping (diagnóstico)
router.get('/:id/maxi-ping', maxiPing);

/* CRUD base */
router.get('/',         businesses.listMine);
router.post('/',        businesses.create);
router.get('/active',   businesses.getActive);
router.patch('/active', businesses.setActive);

/* Por :id */
router.get('/:id',           businesses.getOne);
router.patch('/:id',         businesses.update);
router.delete('/:id',        businesses.remove);
router.post('/:id/select',   businesses.select);

// Maxi creds/status
router.get('/:id/maxi-status',       businesses.maxiStatus);
router.post('/:id/maxi-credentials', businesses.maxiSave);

// Artículos / datos
router.get('/:id/articles',      listArticlesFromDB);
router.get('/:id/articles/tree', listArticlesTreeFromDB);
router.post('/:id/sync',         syncNow);

// Ventas: backfill 30d o incremental
router.post('/:id/sync-sales', async (req, res, next) => {
  try {
    const mode = (req.query.mode === 'backfill') ? 'backfill_30d' : 'auto';
    const out  = await syncSalesForBusiness(req.business, { mode, req });
    res.json({ ok: true, business_id: req.business.id, sales: out });
  } catch (e) { next(e); }
});

module.exports = router;

