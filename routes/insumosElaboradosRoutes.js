// routes/insumosElaboradosRoutes.js
'use strict';
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/insumosElaboradosController');

// El guard global /api ya aplica authRequired — no hace falta repetirlo acá

router.patch('/:id/elaborado', ctrl.toggleInsumoElaborado);
router.post('/elaborado/bulk', ctrl.toggleInsumosElaboradosBulk);
router.get('/elaborados', ctrl.listInsumosElaborados);
router.get('/elaborados/stats', ctrl.getElaboradosStats);
router.post('/elaborados/mover-a-grupo', ctrl.moverElaboradosAGrupo);
router.get('/:id/receta', ctrl.getInsumoReceta);
router.post('/:id/receta', ctrl.saveInsumoReceta);
router.delete('/:id/receta', ctrl.deleteInsumoReceta);

module.exports = router;