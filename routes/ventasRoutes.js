// routes/ventasRoutes.js
const express = require('express');
const router = express.Router();

const ventasCtrl = require('../controllers/ventasController');
const { requireBusiness } = require('../middleware/business');

// ping
router.get('/ping', (_req, res) => res.json({ ok: true }));

// GET /api/ventas  (ya viene con auth + loadActiveBusiness por app.js)
router.get('/',
  requireBusiness,       
  ventasCtrl.getVentas
);

module.exports = router;
