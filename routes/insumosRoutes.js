// routes/insumosRoutes.js
const router = require('express').Router();
const ctrl = require('../controllers/insumosController');

// Valida que existan y sean funciones; si no, loguea y crea un stub 501
const requiredHandlers = [
  'syncDesdeMaxi',
  'syncDesdeCompras',
  'listar',
  'crearManual',
  'actualizar',
  'eliminar',
  '__cleanupNullInsumos',
];

for (const k of requiredHandlers) {
  if (typeof ctrl[k] !== 'function') {
    console.error(`[insumosRoutes] Handler faltante o inválido: ${k}. Tipo: ${typeof ctrl[k]}`);
    ctrl[k] = (req, res) =>
      res.status(501).json({ ok: false, message: `Handler ${k} no implementado` });
  }
}

router.post('/sync-maxi', ctrl.syncDesdeMaxi);
router.post('/sync-compras', ctrl.syncDesdeCompras);
router.get('/', ctrl.listar);
router.post('/', ctrl.crearManual);
router.put('/:id', ctrl.actualizar);
router.delete('/:id', ctrl.eliminar);
router.post('/admin/cleanup-null', ctrl.__cleanupNullInsumos);

// Debug helpers
router.post('/__debugLogin', ctrl.__debugLogin);
router.post('/__debugInsumos', ctrl.__debugInsumos);
router.post('/__debugCombo', ctrl.__debugCombo);
router.post('/__debugCompras', ctrl.__debugCompras); // 👈 esta es la que faltó

module.exports = router;
