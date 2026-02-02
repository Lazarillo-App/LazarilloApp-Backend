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
} = require('../controllers/agrupacionesController');

const { materializeGroupsFromTaxonomy } = require('../services/autoGroupingService');

const safe = (fn, name) =>
  typeof fn === 'function'
    ? fn
    : (req, res) =>
        res.status(501).json({ ok: false, error: `Handler faltante: ${name}` });

// Todas bajo /api/businesses/:businessId/...
router.post('/agrupaciones', safe(crearAgrupacion, 'crearAgrupacion'));
router.get('/agrupaciones', safe(obtenerAgrupaciones, 'obtenerAgrupaciones'));

router.put('/agrupaciones/todo', safe(ensureTodoAgrupacion, 'ensureTodoAgrupacion'));

// ✅ Asignar / desasignar agrupación a división
// POST /api/businesses/:businessId/agrupaciones/:groupId/assign-division
// body: { divisionId: number | null }
router.post(
  '/agrupaciones/:groupId/assign-division',
  safe(assignAgrupacionToDivision, 'assignAgrupacionToDivision')
);

router.put('/agrupaciones/:id', safe(actualizarAgrupacion, 'actualizarAgrupacion'));
router.delete('/agrupaciones/:id', safe(eliminarAgrupacion, 'eliminarAgrupacion'));

router.put('/agrupaciones/:id/articulos', safe(agregarArticulosAgrupacion, 'agregarArticulosAgrupacion'));
router.delete(
  '/agrupaciones/:id/articulos/:articuloId',
  safe(eliminarArticuloDeAgrupacion, 'eliminarArticuloDeAgrupacion')
);

router.get('/agrupaciones/:id/exclusiones', safe(listarExclusiones, 'listarExclusiones'));
router.post('/agrupaciones/:id/exclusiones', safe(upsertExclusiones, 'upsertExclusiones'));

router.post('/agrupaciones/:fromId/move-items', safe(moveItemsBetweenGroups, 'moveItemsBetweenGroups'));
router.post('/agrupaciones/create-or-move', safe(createOrMoveAgrupacion, 'createOrMoveAgrupacion'));

// ⬇️ NUEVO: materializar agrupaciones desde taxonomía (idempotente)
// POST /api/businesses/:businessId/agrupaciones/auto-from-taxonomy?strategy=by-subrubro|by-categoria
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

router.get('/agrupaciones', async (req, res) => {
  try {
    const businessId = req.headers['x-business-id'];
    const divisionId = req.headers['x-division-id']; // ✅ NUEVO
    
    if (!businessId) {
      return res.status(400).json({ error: 'businessId requerido' });
    }

    // Obtener todas las agrupaciones del negocio
    const agrupaciones = await db.query(
      `SELECT * FROM agrupaciones WHERE business_id = $1 ORDER BY nombre`,
      [businessId]
    );

    let result = agrupaciones.rows;
    let filteredByDivision = false;

    // ✅ FILTRADO POR DIVISIÓN
    if (divisionId && divisionId !== 'null' && divisionId !== 'undefined') {
      filteredByDivision = true;

      // Obtener grupos asignados a esta división
      const assignedGroups = await db.query(
        `SELECT group_id FROM division_group_assignments 
         WHERE division_id = $1 AND scope = 'articulos'`,
        [divisionId]
      );

      const assignedIds = new Set(assignedGroups.rows.map(r => Number(r.group_id)));

      // Filtrar: SOLO grupos asignados (sin TODO ni Discontinuados)
      result = result.filter(g => {
        const nombre = String(g.nombre || '').toLowerCase().trim();
        
        // ❌ Excluir TODO y Discontinuados de divisiones
        const isTodo = nombre === 'todo' || nombre === 'sin agrupacion' || nombre === 'sin agrupación';
        const isDisc = nombre === 'discontinuados' || nombre === 'descontinuados';
        
        if (isTodo || isDisc) return false;
        
        // ✅ Incluir solo si está asignado
        return assignedIds.has(Number(g.id));
      });
    }

    res.json({
      agrupaciones: result,
      total: result.length,
      filtered_by_division: filteredByDivision,
      division_id: divisionId || null,
    });

  } catch (error) {
    console.error('Error en /agrupaciones:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
