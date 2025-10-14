// routes/ventasRoutes.js
const express = require('express');
const router = express.Router();

const { authRequired, loadActiveBusiness } = require('../middleware/authMiddleware');
const forbidAppAdmin = require('../middleware/forbidAppAdmin');
const requireBusinessAccess = require('../middleware/requireBusinessAccess');

const { getVentas, getSummary, getArticleSeries } = require('../controllers/ventasController');

// Wrapper: pasa el businessId correcto a requireBusinessAccess(req,res,next, id)
const requireBiz = (req, res, next) => {
  const id = req.business?.id || req.businessId || Number(req.header('X-Business-Id'));
  return requireBusinessAccess(req, res, next, id);
};

// Rutas principales (desde DB)
router.get('/', authRequired, forbidAppAdmin, loadActiveBusiness, requireBiz, getVentas);
router.get('/summary', authRequired, forbidAppAdmin, loadActiveBusiness, requireBiz, getSummary);
router.get('/:articuloId/series', authRequired, forbidAppAdmin, loadActiveBusiness, requireBiz, getArticleSeries);

module.exports = router;
