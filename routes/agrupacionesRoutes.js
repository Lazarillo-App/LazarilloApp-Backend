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
  ensureTop20Agrupacion,
  upsertArticuloGroupRule,
} = require('../controllers/agrupacionesController');

const { materializeGroupsFromTaxonomy } = require('../services/autoGroupingService');
const blockStaffWrite = require('../middleware/blockStaffWrite');

const safe = (fn, name) =>
  typeof fn === 'function'
    ? fn
    : (req, res) =>
        res.status(501).json({ ok: false, error: `Handler faltante: ${name}` });

// ── Rutas sin parámetro dinámico (SIEMPRE primero en Express) ──
router.post('/agrupaciones', blockStaffWrite, safe(crearAgrupacion, 'crearAgrupacion'));
router.get('/agrupaciones', safe(obtenerAgrupaciones, 'obtenerAgrupaciones'));
router.put('/agrupaciones/todo', safe(ensureTodoAgrupacion, 'ensureTodoAgrupacion'));
router.put('/agrupaciones/top20', safe(ensureTop20Agrupacion, 'ensureTop20Agrupacion'));
router.post('/agrupaciones/create-or-move', blockStaffWrite, safe(createOrMoveAgrupacion, 'createOrMoveAgrupacion'));
router.post('/agrupaciones/group-rules', blockStaffWrite, safe(upsertArticuloGroupRule, 'upsertArticuloGroupRule'));
router.get('/agrupaciones/articulo/:articuloId/origen', safe(getArticuloOrigen, 'getArticuloOrigen'));
router.post('/agrupaciones/articulos/origenes', safe(getArticulosOrigenes, 'getArticulosOrigenes'));
router.post('/agrupaciones/auto-from-taxonomy', blockStaffWrite, async (req, res, next) => {
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
  blockStaffWrite,
  safe(assignAgrupacionToDivision, 'assignAgrupacionToDivision')
);

// ── Rutas con :id dinámico (SIEMPRE después de las estáticas) ──
router.put('/agrupaciones/:id', blockStaffWrite, safe(actualizarAgrupacion, 'actualizarAgrupacion'));
router.delete('/agrupaciones/:id', blockStaffWrite, safe(eliminarAgrupacion, 'eliminarAgrupacion'));
router.put('/agrupaciones/:id/articulos', blockStaffWrite, safe(agregarArticulosAgrupacion, 'agregarArticulosAgrupacion'));
router.delete('/agrupaciones/:id/articulos', blockStaffWrite, safe(eliminarArticulosDeAgrupacionBulk, 'eliminarArticulosDeAgrupacionBulk'));
router.delete('/agrupaciones/:id/articulos/:articuloId', blockStaffWrite, safe(eliminarArticuloDeAgrupacion, 'eliminarArticuloDeAgrupacion'));
router.get('/agrupaciones/:id/exclusiones', safe(listarExclusiones, 'listarExclusiones'));
router.post('/agrupaciones/:id/exclusiones', blockStaffWrite, safe(upsertExclusiones, 'upsertExclusiones'));
router.post('/agrupaciones/:fromId/move-items', blockStaffWrite, safe(moveItemsBetweenGroups, 'moveItemsBetweenGroups'));
router.post('/agrupaciones/move-cross-biz', blockStaffWrite, safe(moveCrossBiz, 'moveCrossBiz'));

module.exports = router;