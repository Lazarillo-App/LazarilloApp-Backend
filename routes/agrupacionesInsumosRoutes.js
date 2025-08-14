// routes/agrupacionesInsumosRoutes.js
const router = require('express').Router();
const ctrl = require('../controllers/agrupacionesInsumosController');

// CRUD de grupos de insumos
router.get('/', ctrl.listar);                // lista grupos + cantidad de insumos
router.post('/', ctrl.crear);                // crea grupo y (opcional) items
router.delete('/:id', ctrl.eliminar);        // baja lógica del grupo

// Items del grupo (agregar / quitar)
router.post('/:id/items', ctrl.agregarItems);              // body: { insumoIds: [1,2,3] }
router.delete('/:id/items/:insumoId', ctrl.quitarItem);    // quita un item

module.exports = router;
