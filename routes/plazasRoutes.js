// routes/plazasRoutes.js — plazas de despacho (ver controllers/plazasController.js)
// Monta en: app.use('/api/businesses/:businessId/plazas', plazasRoutes)
'use strict';
const router = require('express').Router({ mergeParams: true });
const ctrl = require('../controllers/plazasController');
const pantallas = require('../controllers/pantallasController');

router.get('/', ctrl.list);
router.get('/articulos', ctrl.articulos);
router.put('/colores', ctrl.guardarColor);
router.post('/', ctrl.create);
router.get('/:id/vista', ctrl.vista);
router.put('/:id/fichas/:articleId/item', ctrl.editarItem);
router.put('/:id/ocultar', ctrl.ocultar);
router.put('/:id/fichas/:articleId', ctrl.guardarFicha);
// TVs de la plaza (Vincular TV / desvincular), ver controllers/pantallasController.js
router.get('/:id/pantallas', pantallas.listar);
router.post('/:id/pantallas', pantallas.vincular);
router.delete('/:id/pantallas/:pid', pantallas.desvincular);
router.put('/:id', ctrl.update);
router.delete('/:id', ctrl.remove);

module.exports = router;
