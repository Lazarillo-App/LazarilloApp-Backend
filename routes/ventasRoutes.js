const express = require('express');
const router = express.Router();
const { getVentas, getVentasBatch } = require('../controllers/ventasController');

// GET /api/ventas?articuloId=...&from=...&to=...&groupBy=...
router.get('/', getVentas);

// (Opcional) POST /api/ventas/batch
// Si no usas batch, elimina esta línea y también la export en el controller
router.post('/batch', getVentasBatch);

module.exports = router;
