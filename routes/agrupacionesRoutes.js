// agrupacionesRoutes.js
const express = require('express');
const router = express.Router();
const {
  crearAgrupacion,
  obtenerAgrupaciones,
  editarAgrupacion,
  eliminarAgrupacion,
  agregarArticulosAAgrupacion,
  obtenerArticulosDeAgrupacion
} = require('../controllers/agrupacionesController');

// 🟢 Rutas para agrupaciones
router.post('/agrupaciones', crearAgrupacion);
router.get('/agrupaciones', obtenerAgrupaciones);
router.delete('/agrupaciones/:id', eliminarAgrupacion);
router.put('/agrupaciones/:id', editarAgrupacion);

// 🔵 Rutas para artículos dentro de agrupaciones
router.post('/agrupaciones/:id/articulos', agregarArticulosAAgrupacion);
router.get('/agrupaciones/:id/articulos', obtenerArticulosDeAgrupacion);

module.exports = router;