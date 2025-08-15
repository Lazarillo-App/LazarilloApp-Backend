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
  ensureTodoAgrupacion,     // 👈 import correcto
  listarExclusiones,
  upsertExclusiones
} = require('../controllers/agrupacionesController');

router.post('/agrupaciones', crearAgrupacion);
router.get('/agrupaciones', obtenerAgrupaciones);
router.put('/agrupaciones/:id', actualizarAgrupacion);
router.delete('/agrupaciones/:id', eliminarAgrupacion);
router.put('/agrupaciones/:id/articulos', agregarArticulosAgrupacion);
router.delete('/agrupaciones/:id/articulos/:articuloId', eliminarArticuloDeAgrupacion);

// ====== TODO + exclusiones ======
router.put('/agrupaciones/todo', ensureTodoAgrupacion);         // 👈 SOLO esta
router.get('/agrupaciones/:id/exclusiones', listarExclusiones);
router.post('/agrupaciones/:id/exclusiones', upsertExclusiones);

module.exports = router;