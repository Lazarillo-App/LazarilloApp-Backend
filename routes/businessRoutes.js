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

// POST /:id/sync-sales?mode=backfill&dryrun=1&from=YYYY-MM-DD&to=YYYY-MM-DD
router.post('/:id/sync-sales', async (req, res, next) => {
  try {
    const bizId =
      Number(req.business?.id) ||
      Number(req.params.id) ||
      Number(req.headers['x-business-id']);

    if (!Number.isFinite(bizId)) {
      return res.status(400).json({ error: 'invalid_business_id' });
    }

    // "business" mínimo: alcanza con el id
    const business = req.business || { id: bizId };

    const mode = req.query.mode === 'backfill' ? 'backfill_30d' : 'auto';
    const dryrun = req.query.dryrun === '1' || req.query.dryrun === 'true';

    const from = req.query.from ? new Date(req.query.from) : null;
    const to   = req.query.to   ? new Date(req.query.to)   : null;
    if ((from && isNaN(+from)) || (to && isNaN(+to))) {
      return res.status(400).json({ error: 'invalid_date' });
    }

    const { syncSalesForBusiness } = require('../controllers/salesSyncController');
    const out = await syncSalesForBusiness(business, { mode, from, to, dryrun, req });

    res.json({ ok: true, business_id: bizId, sales: out });
  } catch (e) {
    next(e);
  }
});

module.exports = router;


