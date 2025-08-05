// agrupacionesRoutes.js
const express = require('express');
const router = express.Router();
const {
  crearAgrupacion,
  obtenerAgrupaciones,
  actualizarAgrupacion,
  eliminarAgrupacion,
  agregarArticulosAgrupacion,
  eliminarArticuloDeAgrupacion
} = require('../controllers/agrupacionesController');

// Crear y obtener agrupaciones
router.post('/agrupaciones', crearAgrupacion);
router.get('/agrupaciones', obtenerAgrupaciones);

// Actualizar agrupación (nombre y/o artículos)
router.put('/agrupaciones/:id', actualizarAgrupacion);

// Eliminar agrupación completa
router.delete('/agrupaciones/:id', eliminarAgrupacion);

// Agregar nuevos artículos (opcional, si querés ruta separada)
router.put('/agrupaciones/:id/articulos', agregarArticulosAgrupacion);

// Eliminar un artículo específico
router.delete('/agrupaciones/:id/articulos/:articuloId', eliminarArticuloDeAgrupacion);

module.exports = router;