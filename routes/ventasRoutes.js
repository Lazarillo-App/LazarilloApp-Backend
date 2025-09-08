const express = require('express');
const router = express.Router();

const authRequired = require('../middleware/authMiddleware');
const ventasCtrl = require('../controllers/ventasController'); // 👈 mismas letras que abajo
const { loadActiveBusiness, requireBusiness } = require('../middleware/business');

// ping para probar fácil
router.get('/ping', (_req, res) => res.json({ ok: true }));

// GET /api/ventas
router.get('/',
  authRequired,
  loadActiveBusiness,
  requireBusiness,
  ventasCtrl.getVentas     // 👈 usa el nombre real que exporta el controller
);

module.exports = router;

