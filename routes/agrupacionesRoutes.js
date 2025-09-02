// routes/agrupacionesRoutes.js
const express = require('express');
const router = express.Router();

const {
  crearAgrupacion,
  obtenerAgrupaciones,
  actualizarAgrupacion,
  eliminarAgrupacion,
  agregarArticulosAgrupacion,
  eliminarArticuloDeAgrupacion,
  ensureTodoAgrupacion,
  listarExclusiones,
  upsertExclusiones,
  moveItemsBetweenGroups 
} = require('../controllers/agrupacionesController');

// --- Rutas sin :id ---
router.post('/agrupaciones', crearAgrupacion);
router.get('/agrupaciones', obtenerAgrupaciones);

// 👇 IMPORTANTE: esta va ANTES de las que tienen :id
router.put('/agrupaciones/todo', ensureTodoAgrupacion);

// --- Rutas con :id (sin regex, ordenadas luego de /todo) ---
router.put('/agrupaciones/:id', actualizarAgrupacion);
router.delete('/agrupaciones/:id', eliminarAgrupacion);

router.put('/agrupaciones/:id/articulos', agregarArticulosAgrupacion);
router.delete('/agrupaciones/:id/articulos/:articuloId', eliminarArticuloDeAgrupacion);

// Exclusiones
router.get('/agrupaciones/:id/exclusiones', listarExclusiones);
router.post('/agrupaciones/:id/exclusiones', upsertExclusiones);
router.post('/agrupaciones/:fromId/move-items', moveItemsBetweenGroups);

module.exports = router;