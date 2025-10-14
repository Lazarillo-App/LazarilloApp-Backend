// routes/ventasRoutes.js
const express = require('express');
const router = express.Router();

const { authRequired, loadActiveBusiness } = require('../middleware/authMiddleware');
const forbidAppAdmin = require('../middleware/forbidAppAdmin');
const requireBusinessAccess = require('../middleware/requireBusinessAccess');

const {
  getVentas,              // /api/ventas?peek=... | /api/ventas?from&to&groupBy=
  getSummary,             // legado
  getArticleSeries,       // legado /:articuloId/series
  getArticleSeriesQuery,  // compat por query -> /by-article
} = require('../controllers/ventasController');

const requireBiz = (req, res, next) => {
  const id = req.business?.id || req.businessId || Number(req.header('X-Business-Id'));
  return requireBusinessAccess(req, res, next, id);
};

// Raíz (peek + series agregadas desde DB)
router.get('/',        authRequired, forbidAppAdmin, loadActiveBusiness, requireBiz, getVentas);
router.get('/series',  authRequired, forbidAppAdmin, loadActiveBusiness, requireBiz, getVentas);

// Ranking (legado)
router.get('/summary', authRequired, forbidAppAdmin, loadActiveBusiness, requireBiz, getSummary);

// Serie por artículo por path param (ID de Maxi == article_id)
router.get('/:articuloId/series', authRequired, forbidAppAdmin, loadActiveBusiness, requireBiz, getArticleSeries);

// Compat por query en ruta separada
router.get('/by-article', authRequired, forbidAppAdmin, loadActiveBusiness, requireBiz, getArticleSeriesQuery);

module.exports = router;
