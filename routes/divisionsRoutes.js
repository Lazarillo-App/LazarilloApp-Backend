// routes/divisionsRoutes.js
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/divisionsController');

const { authRequired, loadActiveBusiness } = require('../middleware/authMiddleware');

const safe = (fn, name) =>
  typeof fn === 'function'
    ? fn
    : (req, res) => res.status(501).json({ ok: false, error: `Handler faltante: ${name}` });

// Todas las rutas requieren autenticación
router.use(authRequired);
router.use(loadActiveBusiness);

/* CRUD DE DIVISIONES */
router.get('/business/:businessId', safe(ctrl.getDivisionsByBusiness, 'getDivisionsByBusiness'));
router.get('/business/:businessId/hierarchy', safe(ctrl.getBusinessHierarchy || ctrl.getDivisionsByBusiness, 'getBusinessHierarchy|getDivisionsByBusiness'));
router.get('/business/:businessId/main', safe(ctrl.getMainDivision || ctrl.getDivisionsByBusiness, 'getMainDivision|getDivisionsByBusiness'));
router.get('/business/:businessId/all-subnegocios', safe(ctrl.getAllSubnegocios || ctrl.getDivisionsByBusiness, 'getAllSubnegocios|getDivisionsByBusiness'));
router.get('/business/:businessId/stats', safe(ctrl.getStatsWithSubnegocios || ctrl.getDivisionsByBusiness, 'getStatsWithSubnegocios|getDivisionsByBusiness'));

router.post('/', safe(ctrl.createDivision, 'createDivision'));
router.get('/:divisionId', safe(ctrl.getDivisionById, 'getDivisionById'));
router.put('/:divisionId', safe(ctrl.updateDivision, 'updateDivision'));
router.delete('/:divisionId', safe(ctrl.deleteDivision, 'deleteDivision'));

/* MOVER AGRUPACIONES Y ARTÍCULOS */
router.post('/move-agrupacion-complete', safe(ctrl.moveAgrupacionComplete, 'moveAgrupacionComplete'));
router.post('/:divisionId/move-agrupacion', safe(ctrl.moveAgrupacionToSubnegocio || ctrl.moveAgrupacionComplete, 'moveAgrupacionToSubnegocio|moveAgrupacionComplete'));
router.post('/:divisionId/move-articles', safe(ctrl.moveArticlesToSubnegocio || ctrl.moveAgrupacionComplete, 'moveArticlesToSubnegocio|moveAgrupacionComplete'));

/* GRUPOS ASIGNADOS */
router.get('/:divisionId/groups', safe(ctrl.getGroupsByDivision, 'getGroupsByDivision'));
router.post('/:divisionId/assign-group', safe(ctrl.assignGroupToDivision, 'assignGroupToDivision'));
router.delete('/:divisionId/groups/:groupId', safe(ctrl.removeGroupFromDivision, 'removeGroupFromDivision'));

/* INSUMOS (opcionales) */
router.get('/business/:businessId/insumos-stats', safe(ctrl.getInsumosStats || ((req, res) => res.json({ ok: true, stats: {} })), 'getInsumosStats'));
router.get('/business/:businessId/insumos-by-rubro', safe(ctrl.getInsumosByRubro || ((req, res) => res.json({ ok: true, rubros: [] })), 'getInsumosByRubro'));
router.post('/:divisionId/move-insumos', safe(ctrl.moveInsumosToSubnegocio || ((req, res) => res.json({ ok: true, moved: 0 })), 'moveInsumosToSubnegocio'));
router.post('/business/:businessId/move-insumos-by-rubro', safe(ctrl.moveInsumosByRubroToSubnegocio || ((req, res) => res.json({ ok: true, moved: 0 })), 'moveInsumosByRubroToSubnegocio'));

module.exports = router;
