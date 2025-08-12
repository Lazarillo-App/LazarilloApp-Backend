const router = require('express').Router();
const ctrl = require('../controllers/insumosController');

router.post('/sync-maxi', ctrl.syncDesdeMaxi);
// (opcional para dev) router.get('/sync-maxi', ctrl.syncDesdeMaxi);

router.get('/', ctrl.listar);
router.post('/', ctrl.crearManual);
router.put('/:id', ctrl.actualizar);
router.delete('/:id', ctrl.eliminar);
router.post('/admin/cleanup-null', ctrl.__cleanupNullInsumos);
module.exports = router;