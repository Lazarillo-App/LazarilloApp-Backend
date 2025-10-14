const express = require('express');
const router = express.Router();

const { authRequired, loadActiveBusiness } = require('../middleware/authMiddleware');
const forbidAppAdmin = require('../middleware/forbidAppAdmin');
const requireBusinessAccess = require('../middleware/requireBusinessAccess');

const {
  getVentas,              // NUEVO: /api/ventas?peek=|from&to&groupBy=
  getSummary,             // legado
  getArticleSeries,       // legado /:articuloId/series
  getArticleSeriesQuery,  // compat por query -> la movemos a /by-article
} = require('../controllers/ventasController');

const requireBiz = (req, res, next) => {
  const id = req.business?.id || req.businessId || Number(req.header('X-Business-Id'));
  return requireBusinessAccess(req, res, next, id);
};

// ✅ La raíz vuelve a apuntar al handler nuevo (soporta peek=true)
router.get('/', authRequired, forbidAppAdmin, loadActiveBusiness, requireBiz, getVentas);

// Series agregadas por negocio (equivalente explícito)
router.get('/series', authRequired, forbidAppAdmin, loadActiveBusiness, requireBiz, getVentas);

// Ranking (legado)
router.get('/summary', authRequired, forbidAppAdmin, loadActiveBusiness, requireBiz, getSummary);

// Serie por artículo por path param (legado)
router.get('/:articuloId/series', authRequired, forbidAppAdmin, loadActiveBusiness, requireBiz, getArticleSeries);

// 🔀 Compat de firma antigua por QUERY, pero en una URL separada para no interferir:
router.get('/by-article', authRequired, forbidAppAdmin, loadActiveBusiness, requireBiz, getArticleSeriesQuery);

module.exports = router;


