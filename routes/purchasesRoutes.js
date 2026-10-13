// routes/purchasesRoutes.js
'use strict';
const router      = require('express').Router();
const ctrl        = require('../controllers/purchasesController');
const batchesCtrl = require('../controllers/purchasesBatchesController');

router.post('/sync',           ctrl.sync);
router.post('/sync-suppliers', ctrl.syncSuppliers);
router.get('/',           ctrl.list);
router.get('/suppliers',       ctrl.listSuppliers);
router.get('/export/csv',      ctrl.exportCsv);
router.get('/summary',         ctrl.summary);
router.get('/food-cost',       ctrl.foodCost);
router.get('/ranking',         ctrl.ranking);
router.get('/first-date',      ctrl.firstDate);

// ── Gestión de lotes ──────────────────────────────────────────
router.get   ('/batches',                       batchesCtrl.listBatches);
router.get   ('/batches/:batchId/preview',      batchesCtrl.previewBatch);   
router.delete('/batches/:batchId',              batchesCtrl.deleteBatch);
router.post  ('/batches/:batchId/move',         batchesCtrl.moveBatch);
// ─────────────────────────────────────────────────────────────

router.get('/', ctrl.list);

module.exports = router;