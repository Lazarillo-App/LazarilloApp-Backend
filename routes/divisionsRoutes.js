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

// Estadísticas de una división (grupos, artículos)
router.get('/:divisionId/stats', ctrl.getDivisionStats);

// Obtener artículos de una división (FILTRADOS por grupos asignados)
router.get('/:divisionId/articles', ctrl.getArticlesByDivision);

// ============================================================================
// GESTIÓN DE GRUPOS
// ============================================================================

// Listar grupos asignados a una división
router.get('/:divisionId/groups', ctrl.getGroupsByDivision);

// Asignar un grupo a una división
router.post('/:divisionId/assign-group', ctrl.assignGroupToDivision);

// Volver a Principal (desasignar)
router.post('/unassign-group', ctrl.unassignGroupFromDivision);

// Remover grupo de una división (por division+group)
router.delete('/:divisionId/groups/:groupId', ctrl.removeGroupFromDivision);

module.exports = router;