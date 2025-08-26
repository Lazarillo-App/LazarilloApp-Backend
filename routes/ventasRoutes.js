// routes/ventasRoutes.js
const express = require('express');
const router = express.Router();
const { getVentas } = require('../controllers/ventasController');

router.get('/', getVentas);
router.post('/ventas/batch', ventasController.getVentasBatch);

module.exports = router;