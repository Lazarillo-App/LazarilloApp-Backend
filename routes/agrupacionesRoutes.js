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

const { materializeGroupsFromTaxonomy } = require('../services/autoGroupingService');

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

// ⬇️ NUEVO: materializar agrupaciones desde taxonomía (idempotente)
router.post('/agrupaciones/auto-from-taxonomy', async (req, res, next) => {
  try {
    const businessId = Number(req.params.businessId);
    const strategy = req.query.strategy === 'by-subrubro' ? 'by-subrubro' : 'by-categoria';
    const out = await materializeGroupsFromTaxonomy(businessId, { strategy });
    res.json({ ok: true, strategy, ...out });
  } catch (e) { next(e); }
});

module.exports = router;
