const express = require('express');
const router = express.Router();

const businesses = require('../controllers/businessController');
const { listArticlesFromDB, listArticlesTreeFromDB,
        salesSummaryFromDB, salesSeriesFromDB,
        syncNow } = require('../controllers/syncController');

// rutas con :id y sufijos
router.get('/:id/articles', listArticlesFromDB);
router.get('/:id/articles/tree', listArticlesTreeFromDB);
router.post('/:id/sync', syncNow);
router.get('/:id/sales/summary', salesSummaryFromDB);
router.get('/:id/sales/:articuloId', salesSeriesFromDB);
router.get('/:id/maxi-status', businesses.maxiStatus);
router.post('/:id/maxi-credentials', businesses.maxiSave);

// CRUD base
router.get('/', businesses.listMine);
router.post('/', businesses.create);
router.get('/active', businesses.getActive);
router.patch('/active', businesses.setActive);

// por :id
router.get('/:id', businesses.getOne);
router.patch('/:id', businesses.update);
router.delete('/:id', businesses.remove);
router.post('/:id/select', businesses.select);

module.exports = router;
