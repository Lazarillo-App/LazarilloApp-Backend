// routes/ventasRoutes.js
const express = require('express');
const router = express.Router();

const { authRequired, loadActiveBusiness } = require('../middleware/authMiddleware');
const forbidAppAdmin = require('../middleware/forbidAppAdmin');
const requireBusinessAccess = require('../middleware/requireBusinessAccess');

// ⬇️ importa también getArticleSeriesQuery
const { getVentas, getSummary, getArticleSeries, getArticleSeriesQuery } =
  require('../controllers/ventasController');

// Wrapper para validar pertenencia al negocio activo
const requireBiz = (req, res, next) => {
  const id = req.business?.id || req.businessId || Number(req.header('X-Business-Id'));
  return requireBusinessAccess(req, res, next, id);
};

/**
 * Rutas:
 * - GET /api/ventas/series?from&to&groupBy=day|week|month   -> series agregadas desde sales_daily
 * - GET /api/ventas/summary                                 -> ranking (legado)
 * - GET /api/ventas/:articuloId/series?from&to              -> serie por artículo (legado)
 * - GET /api/ventas?articuloId=&from=&to=&groupBy=          -> COMPAT vieja firma (lee DB) -> { total, items:[{label,qty}] }
 */

// Series agregadas por negocio (desde sales_daily)
router.get('/series', authRequired, forbidAppAdmin, loadActiveBusiness, requireBiz, getVentas);

// Ranking artículos (legado)
router.get('/summary', authRequired, forbidAppAdmin, loadActiveBusiness, requireBiz, getSummary);

// Serie por artículo (legado por path param)
router.get('/:articuloId/series', authRequired, forbidAppAdmin, loadActiveBusiness, requireBiz, getArticleSeries);

// Compat: misma firma que usabas antes (?articuloId=&from=&to=&groupBy=)
router.get('/', authRequired, forbidAppAdmin, loadActiveBusiness, requireBiz, getArticleSeriesQuery);

module.exports = router;

