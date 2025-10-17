const express = require('express');
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
  moveItemsBetweenGroups,
  createOrMoveAgrupacion
} = require('../controllers/agrupacionesController');

// Todas bajo /businesses/:businessId/...
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
router.post('/agrupaciones/create-or-move', createOrMoveAgrupacion);

module.exports = router;

