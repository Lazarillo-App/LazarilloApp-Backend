// routes/agrupacionesRoutes.js
const express = require('express');
// 👇 mergeParams para acceder a req.params.businessId
const router = express.Router({ mergeParams: true });

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

// Todas las rutas quedan bajo /businesses/:businessId/...
router.post('/agrupaciones', crearAgrupacion);
router.get('/agrupaciones', obtenerAgrupaciones);
router.put('/agrupaciones/todo', ensureTodoAgrupacion);

router.put('/agrupaciones/:id', actualizarAgrupacion);
router.delete('/agrupaciones/:id', eliminarAgrupacion);

router.put('/agrupaciones/:id/articulos', agregarArticulosAgrupacion);
router.delete('/agrupaciones/:id/articulos/:articuloId', eliminarArticuloDeAgrupacion);

router.get('/agrupaciones/:id/exclusiones', listarExclusiones);
router.post('/agrupaciones/:id/exclusiones', upsertExclusiones);
router.post('/agrupaciones/:fromId/move-items', moveItemsBetweenGroups);

module.exports = router;