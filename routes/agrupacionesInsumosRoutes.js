const router = require('express').Router();
const ctrl = require('../controllers/agrupacionesInsumosController');

router.get('/', ctrl.listar);
router.post('/', ctrl.crear);
router.delete('/:id', ctrl.eliminar);

router.post('/:id/items', ctrl.agregarItems);
router.delete('/:id/items/:insumoId', ctrl.quitarItem);

module.exports = router;