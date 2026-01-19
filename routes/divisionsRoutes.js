const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/divisionsController');

// GESTIÓN DE SUBNEGOCIOS
router.get('/business/:businessId', ctrl.getDivisionsByBusiness);
router.get('/business/:businessId/main', ctrl.getMainDivision);
router.get('/business/:businessId/hierarchy', ctrl.getBusinessHierarchy);
router.get('/business/:businessId/all-subnegocios', ctrl.getAllSubnegocios);
router.get('/business/:businessId/stats', ctrl.getStatsWithSubnegocios);
router.get('/:divisionId', ctrl.getDivisionById);
router.post('/', ctrl.createDivision);
router.put('/:divisionId', ctrl.updateDivision);
router.delete('/:divisionId', ctrl.deleteDivision);

// INSUMOS EN SUBNEGOCIOS
router.get('/business/:businessId/insumos-stats', ctrl.getInsumosStats);
router.get('/business/:businessId/insumos-by-rubro', ctrl.getInsumosByRubro);
router.post('/:divisionId/move-insumos', ctrl.moveInsumosToSubnegocio);
router.post('/business/:businessId/move-insumos-by-rubro', ctrl.moveInsumosByRubroToSubnegocio);

// 🆕 MOVER ARTÍCULOS Y AGRUPACIONES
router.post('/:divisionId/move-articles', ctrl.moveArticlesToSubnegocio);
router.post('/:divisionId/move-agrupacion', ctrl.moveAgrupacionToSubnegocio);
router.post('/move-agrupacion-complete', ctrl.moveAgrupacionComplete);

module.exports = router;