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

  // 👇 NUEVO: “TODO” + exclusiones
  ensureTodoAgrupacion,          // PUT /agrupaciones/todo
  listarExclusiones,             // GET /agrupaciones/:id/exclusiones
  upsertExclusiones              // POST /agrupaciones/:id/exclusiones
} = require('../controllers/agrupacionesController');

// Crear y obtener agrupaciones
router.post('/agrupaciones', crearAgrupacion);
router.get('/agrupaciones', obtenerAgrupaciones);

// Actualizar agrupación (nombre y/o artículos)
router.put('/agrupaciones/:id', actualizarAgrupacion);

// Eliminar agrupación completa
router.delete('/agrupaciones/:id', eliminarAgrupacion);

// Agregar nuevos artículos (ruta separada para “append”)
router.put('/agrupaciones/:id/articulos', agregarArticulosAgrupacion);

// Eliminar un artículo específico
router.delete('/agrupaciones/:id/articulos/:articuloId', eliminarArticuloDeAgrupacion);

// ====== NUEVO: Agrupación “TODO” + exclusiones ======
// Asegura/obtiene el grupo “TODO”
router.put('/agrupaciones/todo', ensureTodoAgrupacion);

// Listar exclusiones del grupo
router.get('/agrupaciones/:id/exclusiones', listarExclusiones);

// Agregar o quitar exclusiones en lote
// body: { mode: 'add'|'remove', items: [{ scope:'categoria'|'subrubro'|'articulo', ref_id: string|number }] }
router.post('/agrupaciones/:id/exclusiones', upsertExclusiones);

module.exports = router;
