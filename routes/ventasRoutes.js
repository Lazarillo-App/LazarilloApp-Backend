// routes/ventasRoutes.js
const express = require('express');
const router = express.Router();

// 👇 estos SÍ son funciones
const {
  salesSummaryFromDB,
  salesSeriesFromDB,
  listArticlesFromDB,
  listArticlesTreeFromDB,
  syncNow,
} = require('../controllers/syncController');

// GET /api/ventas/summary
router.get('/summary', salesSummaryFromDB);

// GET /api/ventas/:articuloId/series
router.get('/:articuloId/series', salesSeriesFromDB);

// utilitarios (si los usas desde /api/ventas)
router.get('/articles', listArticlesFromDB);
router.get('/articles/tree', listArticlesTreeFromDB);

// POST /api/ventas/sync
router.post('/sync', syncNow);

module.exports = router;
