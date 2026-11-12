// routes/plazasRoutes.js — plazas de despacho (ver controllers/plazasController.js)
// Monta en: app.use('/api/businesses/:businessId/plazas', plazasRoutes)
'use strict';
const router = require('express').Router({ mergeParams: true });
const ctrl = require('../controllers/plazasController');

router.get('/', ctrl.list);
router.get('/articulos', ctrl.articulos);
router.put('/colores', ctrl.guardarColor);
router.post('/', ctrl.create);
router.get('/:id/vista', ctrl.vista);
router.put('/:id/fichas/:articleId/item', ctrl.editarItem);
router.put('/:id/ocultar', ctrl.ocultar);
router.put('/:id/fichas/:articleId', ctrl.guardarFicha);
router.put('/:id', ctrl.update);
router.delete('/:id', ctrl.remove);

module.exports = router;
