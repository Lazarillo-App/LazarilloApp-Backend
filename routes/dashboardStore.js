// routes/dashboardStore.js
// Rutas del almacén del Dashboard de Resultados.
//
// Se montan bajo /api/businesses/:bizId/dashboard-store en app.js.
// El middleware de acceso al negocio (el mismo que usás para el resto de
// rutas /api/businesses/:bizId/...) debe correr ANTES y dejar req.businessId.
//
// IMPORTANTE: la ruta de listado (sin :key) va ANTES que las parametrizadas
// para evitar conflictos de matching en Express.

const express = require('express');
const router = express.Router({ mergeParams: true });
const ctrl = require('../controllers/dashboardStoreController');

// Listado por prefijo:  GET .../dashboard-store?prefix=movstock:
router.get('/', ctrl.listKeys);

// Operaciones por key
router.get('/:key', ctrl.getOne);
router.put('/:key', ctrl.setOne);
router.delete('/:key', ctrl.deleteOne);

module.exports = router;
