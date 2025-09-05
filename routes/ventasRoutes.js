const express = require('express');
const router = express.Router();

const authRequired = require('../middleware/authMiddleware');
const ventasCtrl = require('../controllers/ventasController');
const { loadActiveBusiness, requireBusiness } = require('../middleware/business');

// Ping simple
router.get('/ping', ventasCtrl.ping);

// Este router se monta como app.use('/api/ventas', router) -> GET /api/ventas
router.get('/',
  authRequired,
  loadActiveBusiness,
  requireBusiness,
  ventasCtrl.getVentas
);

module.exports = router;
