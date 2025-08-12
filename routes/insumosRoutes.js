// routes/insumosRoutes.js
const router = require('express').Router();
const ctrl = require('../controllers/insumosController');

router.post('/sync-maxi', ctrl.syncDesdeMaxi);
router.get('/', ctrl.listar);
router.post('/', ctrl.crearManual);
router.put('/:id', ctrl.actualizar);
router.delete('/:id', ctrl.eliminar);

module.exports = router;