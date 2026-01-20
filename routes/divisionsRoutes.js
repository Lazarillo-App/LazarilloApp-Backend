// routes/divisions.js
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/divisionsController');
const { requireAuth } = require('../middleware/authMiddleware');

// Todas las rutas requieren autenticación
router.use(requireAuth);

/* ═══════════════════════════════════════════════════════════════════════════
   CRUD DE DIVISIONES (SUBNEGOCIOS)
   ═══════════════════════════════════════════════════════════════════════════ */

// Listar divisiones de un negocio
router.get('/business/:businessId', ctrl.getDivisionsByBusiness);

// Obtener jerarquía completa
router.get('/business/:businessId/hierarchy', ctrl.getBusinessHierarchy || ctrl.getDivisionsByBusiness);

// Obtener división principal
router.get('/business/:businessId/main', ctrl.getMainDivision || ctrl.getDivisionsByBusiness);

// Obtener todos los subnegocios
router.get('/business/:businessId/all-subnegocios', ctrl.getAllSubnegocios || ctrl.getDivisionsByBusiness);

// Estadísticas con subnegocios
router.get('/business/:businessId/stats', ctrl.getStatsWithSubnegocios || ctrl.getDivisionsByBusiness);

// Crear nueva división
router.post('/', ctrl.createDivision);

// Obtener detalles de una división
router.get('/:divisionId', ctrl.getDivisionById);

// Actualizar división
router.put('/:divisionId', ctrl.updateDivision);

// Eliminar división
router.delete('/:divisionId', ctrl.deleteDivision);

/* ═══════════════════════════════════════════════════════════════════════════
   🆕 MOVER AGRUPACIONES Y ARTÍCULOS (NUEVO SISTEMA)
   ═══════════════════════════════════════════════════════════════════════════ */

// 🔥 ENDPOINT PRINCIPAL: Mover agrupación completa
// Crea división si es necesario + asigna grupo + mueve artículos
router.post('/move-agrupacion-complete', ctrl.moveAgrupacionComplete);

// Mover agrupación a división existente (alternativa simplificada)
router.post('/:divisionId/move-agrupacion', ctrl.moveAgrupacionToSubnegocio || ctrl.moveAgrupacionComplete);

// Mover artículos específicos a división
router.post('/:divisionId/move-articles', ctrl.moveArticlesToSubnegocio || ctrl.moveAgrupacionComplete);

/* ═══════════════════════════════════════════════════════════════════════════
   GESTIÓN DE GRUPOS ASIGNADOS A DIVISIONES
   ═══════════════════════════════════════════════════════════════════════════ */

// Listar grupos asignados a una división
router.get('/:divisionId/groups', ctrl.getGroupsByDivision);

// Asignar grupo a división
router.post('/:divisionId/assign-group', ctrl.assignGroupToDivision);

// Quitar grupo de división
router.delete('/:divisionId/groups/:groupId', ctrl.removeGroupFromDivision);

/* ═══════════════════════════════════════════════════════════════════════════
   INSUMOS EN SUBNEGOCIOS (SISTEMA LEGACY - OPCIONAL)
   ═══════════════════════════════════════════════════════════════════════════ */

// Estadísticas de insumos
router.get('/business/:businessId/insumos-stats', ctrl.getInsumosStats || ((req, res) => res.json({ ok: true, stats: {} })));

// Insumos por rubro
router.get('/business/:businessId/insumos-by-rubro', ctrl.getInsumosByRubro || ((req, res) => res.json({ ok: true, rubros: [] })));

// Mover insumos a subnegocio
router.post('/:divisionId/move-insumos', ctrl.moveInsumosToSubnegocio || ((req, res) => res.json({ ok: true, moved: 0 })));

// Mover insumos por rubro
router.post('/business/:businessId/move-insumos-by-rubro', ctrl.moveInsumosByRubroToSubnegocio || ((req, res) => res.json({ ok: true, moved: 0 })));

module.exports = router;