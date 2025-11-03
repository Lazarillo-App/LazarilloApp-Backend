const express = require('express');
const router = express.Router();

const { authRequired, loadActiveBusiness } = require('../middleware/authMiddleware');
const forbidAppAdmin = require('../middleware/forbidAppAdmin');
const { requireBusinessAccess } = require('../middleware/requireBusinessAccess');

const {
  getVentas,
  getSummary,
  getArticleSeries,
  getArticleSeriesQuery,
} = require('../controllers/ventasController');

// Valida/inyecta negocio (tzoma de header/query/param o active_business_id)
const requireBiz = (req, res, next) => requireBusinessAccess(req, res, next);

// Raíz (peek + series)
router.get('/',        authRequired, forbidAppAdmin, loadActiveBusiness, requireBiz, getVentas);
router.get('/series',  authRequired, forbidAppAdmin, loadActiveBusiness, requireBiz, getVentas);

// Ranking (legado)
router.get('/summary', authRequired, forbidAppAdmin, loadActiveBusiness, requireBiz, getSummary);

// Serie por artículo (legado)
router.get('/:articuloId/series', authRequired, forbidAppAdmin, loadActiveBusiness, requireBiz, getArticleSeries);

// Compat por query
router.get('/by-article', authRequired, forbidAppAdmin, loadActiveBusiness, requireBiz, getArticleSeriesQuery);

module.exports = router;
