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

// ⬇️ importa funciones nombradas del controller de ventas
const { maxiPing, syncSalesForBusiness } = require('../controllers/salesSyncController');

// ... router.param('id') queda igual ...

// Diagnóstico de Maxi (permite ?from=YYYY-MM-DD&to=YYYY-MM-DD)
router.get('/:id/maxi-ping', maxiPing);

/* CRUD base */
router.get('/',         businesses.listMine);
router.post('/',        businesses.create);
router.get('/active',   businesses.getActive);
router.patch('/active', businesses.setActive);

/* Por :id */
router.get('/:id',                 businesses.getOne);
router.patch('/:id',               businesses.update);
router.delete('/:id',              businesses.remove);
router.post('/:id/select',         businesses.select);

// Maxi
router.get('/:id/maxi-status',       businesses.maxiStatus);
router.post('/:id/maxi-credentials', businesses.maxiSave);

// Datos / Sync “viejos”
router.get('/:id/articles',          listArticlesFromDB);
router.get('/:id/articles/tree',     listArticlesTreeFromDB);
router.post('/:id/sync',             syncNow);

router.get('/:id/sales/summary',     salesSummaryFromDB);
router.get('/:id/sales/:articuloId', salesSeriesFromDB);

// ⬇️ Sync de ventas con soporte ?mode=backfill|auto&dryrun=1&from=YYYY-MM-DD&to=YYYY-MM-DD
router.post('/:id/sync-sales', async (req, res, next) => {
  try {
    const { mode, dryrun, from, to } = req.query;
    const chosen = (mode === 'backfill') ? 'backfill_30d' : 'auto';
    const out = await syncSalesForBusiness(req.business, {
      mode: chosen,
      dryrun: dryrun === '1',
      from,
      to,
      req, // pasa headers p/ X-Maxi-Token opcional
    });
    res.json({ ok: true, business_id: req.businessId || req.business.id, sales: out });
  } catch (e) { next(e); }
});

module.exports = router;


