// routes/salesRoutes.js
'use strict';
const router      = require('express').Router();
const batchesCtrl = require('../controllers/salesBatchesController');

// ── Si ya existe un salesController con otros endpoints, importarlo también:
// const ctrl = require('../controllers/salesController');
// router.get('/summary', ctrl.summary);
// router.get('/', ctrl.list);
// etc.

// ── Gestión de lotes de importación CSV ───────────────────────────────────
router.get   ('/batches',                    batchesCtrl.listBatches);
router.get   ('/batches/:batchId/preview',   batchesCtrl.previewBatch);
router.delete('/batches/:batchId',           batchesCtrl.deleteBatch);
router.post  ('/batches/:batchId/move',      batchesCtrl.moveBatch);
// ─────────────────────────────────────────────────────────────────────────

module.exports = router;