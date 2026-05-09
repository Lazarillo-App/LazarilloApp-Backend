// routes/agrupacionesRoutes.js
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
  createOrMoveAgrupacion,
  assignAgrupacionToDivision,
  getArticuloOrigen,
  getArticulosOrigenes,
  eliminarArticulosDeAgrupacionBulk,
  moveCrossBiz,
} = require('../controllers/agrupacionesController');

const { materializeGroupsFromTaxonomy } = require('../services/autoGroupingService');

const safe = (fn, name) =>
  typeof fn === 'function'
    ? fn
    : (req, res) =>
        res.status(501).json({ ok: false, error: `Handler faltante: ${name}` });

// ── Rutas sin parámetro dinámico (SIEMPRE primero en Express) ──
router.post('/agrupaciones', safe(crearAgrupacion, 'crearAgrupacion'));
router.get('/agrupaciones', safe(obtenerAgrupaciones, 'obtenerAgrupaciones'));
router.put('/agrupaciones/todo', safe(ensureTodoAgrupacion, 'ensureTodoAgrupacion'));
router.post('/agrupaciones/create-or-move', safe(createOrMoveAgrupacion, 'createOrMoveAgrupacion'));
router.get('/agrupaciones/articulo/:articuloId/origen', safe(getArticuloOrigen, 'getArticuloOrigen'));
router.post('/agrupaciones/articulos/origenes', safe(getArticulosOrigenes, 'getArticulosOrigenes'));
router.post('/agrupaciones/auto-from-taxonomy', async (req, res, next) => {
  try {
    const businessId = Number(req.params.businessId);
    if (!Number.isFinite(businessId)) {
      return res.status(400).json({ ok: false, error: 'businessId inválido' });
    }
    const strategy = req.query.strategy === 'by-subrubro' ? 'by-subrubro' : 'by-categoria';
    const out = await materializeGroupsFromTaxonomy(businessId, { strategy });
    return res.json({ ok: true, strategy, ...out });
  } catch (e) {
    next(e);
  }
});

// ── Rutas con :groupId ──
router.post(
  '/agrupaciones/:groupId/assign-division',
  safe(assignAgrupacionToDivision, 'assignAgrupacionToDivision')
);

// ── Rutas con :id dinámico (SIEMPRE después de las estáticas) ──
router.put('/agrupaciones/:id', safe(actualizarAgrupacion, 'actualizarAgrupacion'));
router.delete('/agrupaciones/:id', safe(eliminarAgrupacion, 'eliminarAgrupacion'));
router.put('/agrupaciones/:id/articulos', safe(agregarArticulosAgrupacion, 'agregarArticulosAgrupacion'));
router.delete('/agrupaciones/:id/articulos', safe(eliminarArticulosDeAgrupacionBulk, 'eliminarArticulosDeAgrupacionBulk'));
router.delete('/agrupaciones/:id/articulos/:articuloId',safe(eliminarArticuloDeAgrupacion, 'eliminarArticuloDeAgrupacion'));
router.get('/agrupaciones/:id/exclusiones', safe(listarExclusiones, 'listarExclusiones'));
router.post('/agrupaciones/:id/exclusiones', safe(upsertExclusiones, 'upsertExclusiones'));
router.post('/agrupaciones/:fromId/move-items', safe(moveItemsBetweenGroups, 'moveItemsBetweenGroups'));
router.post('/agrupaciones/move-cross-biz', safe(moveCrossBiz, 'moveCrossBiz'));

module.exports = router;