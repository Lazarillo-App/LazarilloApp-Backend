const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/divisionsController');

const { authRequired, loadActiveBusiness } = require('../middleware/authMiddleware');

// Todas las rutas requieren autenticación
router.use(authRequired);
router.use(loadActiveBusiness);

// ============================================================================
// CRUD DE DIVISIONES
// ============================================================================

// Listar divisiones de un negocio
router.get('/business/:businessId', ctrl.getDivisionsByBusiness);

// Obtener división principal
router.get('/business/:businessId/main', ctrl.getMainDivision);

// Crear división
router.post('/', ctrl.createDivision);

// Crear división desde un grupo existente
router.post('/create-from-group', ctrl.createDivisionFromGroup);

// Obtener una división específica
router.get('/:divisionId', ctrl.getDivisionById);

// Actualizar división
router.put('/:divisionId', ctrl.updateDivision);

// Eliminar división
router.delete('/:divisionId', ctrl.deleteDivision);

// ============================================================================
// ESTADÍSTICAS Y CONTENIDO
// ============================================================================

// Estadísticas de una división (grupos, artículos, insumo_groups, insumos)
router.get('/:divisionId/stats', ctrl.getDivisionStats);

// Contenido filtrado por asignaciones
router.get('/:divisionId/articles', ctrl.getArticlesByDivision);
router.get('/:divisionId/insumos', ctrl.getInsumosByDivision);

// ============================================================================
// GESTIÓN DE GRUPOS DE ARTÍCULOS (business_groups)
// ============================================================================

// Listar grupos asignados a una división
router.get('/:divisionId/groups', ctrl.getGroupsByDivision);

// Asignar un grupo a una división
router.post('/:divisionId/assign-group', ctrl.assignGroupToDivision);

// Remover grupo de una división (por division+group)
router.delete('/:divisionId/groups/:groupId', ctrl.removeGroupFromDivision);

// Volver a Principal (desasignar global)
router.post('/unassign-group', ctrl.unassignGroupFromDivision);

// Grupos visibles en Principal (no asignados a ninguna división)
router.get('/business/:businessId/principal-groups', ctrl.getPrincipalGroupsByBusiness);

// ============================================================================
// GESTIÓN DE GRUPOS DE INSUMOS (insumo_groups)  ✅ ESPEJO DE ARTÍCULOS
// ============================================================================

// Listar insumo_groups asignados a una división
router.get('/:divisionId/insumo-groups', ctrl.getInsumoGroupsByDivision);

// Asignar un insumo_group a una división
router.post('/:divisionId/assign-insumo-group', ctrl.assignInsumoGroupToDivision);

// Remover insumo_group de una división (por division+insumo_group)
router.delete('/:divisionId/insumo-groups/:insumoGroupId', ctrl.removeInsumoGroupFromDivision);

// Volver a Principal (desasignar global)
router.post('/unassign-insumo-group', ctrl.unassignInsumoGroup);

// insumo_groups visibles en Principal (no asignados a ninguna división)
router.get(
  '/business/:businessId/principal-insumo-groups',
  ctrl.getPrincipalInsumoGroupsByBusiness
);

// ============================================================================
// LEGACY (agrupaciones) 
// ============================================================================
// router.post('/:divisionId/assign-agrupacion', ctrl.assignAgrupacionToDivision);
// router.post('/unassign-agrupacion', ctrl.unassignAgrupacion);
// router.get('/:divisionId/agrupaciones', ctrl.getAgrupacionesByDivision);
// router.get('/business/:businessId/principal-agrupaciones', ctrl.getPrincipalAgrupacionesByBusiness);

module.exports = router;
