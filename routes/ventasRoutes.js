// src/routes/ventasRoutes.js
const express = require('express');
const router = express.Router();
const ventasCtrl = require('../controllers/ventasController');
const { authRequired } = require('../middleware/authMiddleware');
const { loadActiveBusiness, requireBusiness } = require('../middleware/business');

router.get('/ping', ventasCtrl.ping);

// Requiere usuario logueado y negocio activo (o x-business-id en el header)
router.get('/', authRequired, loadActiveBusiness, requireBusiness, ventasCtrl.getVentas);

module.exports = router;