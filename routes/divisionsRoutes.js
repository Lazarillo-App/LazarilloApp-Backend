/**
 * Rutas de divisiones (subnegocios)
 * Usa app_businesses con parent_id para jerarquía
 */

const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/divisionsController');

// ============================================================================
// RUTAS DE DIVISIONES/SUBNEGOCIOS
// ============================================================================

// GET /api/divisions/business/:businessId - Lista subnegocios de un negocio
router.get('/business/:businessId', ctrl.getDivisionsByBusiness);

// GET /api/divisions/business/:businessId/main - Obtener el negocio principal
router.get('/business/:businessId/main', ctrl.getMainDivision);

// GET /api/divisions/business/:businessId/hierarchy - Jerarquía completa
router.get('/business/:businessId/hierarchy', ctrl.getBusinessHierarchy);

// GET /api/divisions/business/:businessId/all-subnegocios - Todos los subnegocios
router.get('/business/:businessId/all-subnegocios', ctrl.getAllSubnegocios);

// GET /api/divisions/business/:businessId/stats - Estadísticas con subnegocios
router.get('/business/:businessId/stats', ctrl.getStatsWithSubnegocios);

// GET /api/divisions/:divisionId - Obtener una división/subnegocio
router.get('/:divisionId', ctrl.getDivisionById);

// POST /api/divisions - Crear subnegocio
router.post('/', ctrl.createDivision);

// PUT /api/divisions/:divisionId - Actualizar subnegocio
router.put('/:divisionId', ctrl.updateDivision);

// DELETE /api/divisions/:divisionId - Eliminar subnegocio
router.delete('/:divisionId', ctrl.deleteDivision);

// ============================================================================
// RUTAS DE INSUMOS EN SUBNEGOCIOS
// ============================================================================

// GET /api/divisions/business/:businessId/insumos-stats - Estadísticas de insumos
router.get('/business/:businessId/insumos-stats', ctrl.getInsumosStats);

// GET /api/divisions/business/:businessId/insumos-by-rubro - Insumos por rubro
router.get('/business/:businessId/insumos-by-rubro', ctrl.getInsumosByRubro);

// POST /api/divisions/:divisionId/move-insumos - Mover insumos específicos
router.post('/:divisionId/move-insumos', ctrl.moveInsumosToSubnegocio);

// POST /api/divisions/business/:businessId/move-insumos-by-rubro - Mover por rubro
router.post('/business/:businessId/move-insumos-by-rubro', ctrl.moveInsumosByRubroToSubnegocio);

module.exports = router;
