const express = require('express');
const router = express.Router();
const ventasController = require('../controllers/ventasController');

router.get('/ventas', ventasController.getVentas);
router.post('/ventas/batch', ventasController.getVentasBatch);

module.exports = router;