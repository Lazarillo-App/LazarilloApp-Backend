const router = require('express').Router();
const ctrl = require('../controllers/insumosController');

router.post('/sync-maxi', ctrl.syncDesdeMaxi);

// ➕ NUEVA: poblar insumos usando compras (fallback)
router.post('/sync-compras', ctrl.syncDesdeCompras);

router.get('/', ctrl.listar);
router.post('/', ctrl.crearManual);
router.put('/:id', ctrl.actualizar);
router.delete('/:id', ctrl.eliminar);
router.post('/admin/cleanup-null', ctrl.__cleanupNullInsumos);

module.exports = router;
