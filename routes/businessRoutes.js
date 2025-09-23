const express = require('express');
const router = express.Router();

const businesses = require('../controllers/businessController');
const { listArticlesFromDB, listArticlesTreeFromDB,
        salesSummaryFromDB, salesSeriesFromDB,
        syncNow } = require('../controllers/syncController');

// --- Artículos desde BD ---
router.get('/:id/articles', listArticlesFromDB);
router.get('/:id/articles/tree', listArticlesTreeFromDB);

// --- Sincronización y ventas ---
router.post('/:id/sync', syncNow);
router.get('/:id/sales/summary', salesSummaryFromDB);
router.get('/:id/sales/:articuloId', salesSeriesFromDB);

// --- CRUD + selección ---
router.get('/', businesses.listMine);
router.post('/', businesses.create);
router.get('/active', businesses.getActive);
router.patch('/active', businesses.setActive);
router.get('/:id', businesses.getOne);
router.patch('/:id', businesses.update);
router.delete('/:id', businesses.remove);
router.post('/:id/select', businesses.select);

// --- Config/estado MAXI ---
router.get('/:id/maxi-status', businesses.maxiStatus);
router.post('/:id/maxi-credentials', businesses.maxiSave);

module.exports = router;
