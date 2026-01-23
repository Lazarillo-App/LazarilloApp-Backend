// routes/insumosRoutes.js
const router = require('express').Router();
const multer = require('multer');

const ctrl = require('../controllers/insumosController');
const groupsCtrl = require('../controllers/insumosGroupsController');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

/* ================== Maxi: INSUMOS ================== */
router.post('/maxi-sync', ctrl.syncFromMaxi);
router.get('/maxi', ctrl.listarMaxi);

/* ================== Maxi: RUBROS DE INSUMOS ================== */
router.post('/maxi/rubros/sync', ctrl.syncRubrosFromMaxi);
router.get('/maxi/rubros', ctrl.listarRubrosMaxi);

/* ================== AGRUPACIONES DE INSUMOS ================== */
/** Rutas fijas primero */
router.post('/groups/create-or-move', groupsCtrl.createOrMove);

/** CRUD grupos */
router.get('/groups', groupsCtrl.list);
router.get('/groups/:id', groupsCtrl.getOne);
router.post('/groups', groupsCtrl.create);
router.put('/groups/:id', groupsCtrl.update);
router.delete('/groups/:id', groupsCtrl.remove);

/** Items */
router.post('/groups/:id/items/bulk', groupsCtrl.addMultipleItemsToGroup);
router.put('/groups/:id/items', groupsCtrl.replaceItems);
router.post('/groups/:id/items', groupsCtrl.addItemToGroup);
router.delete('/groups/:id/items/:insumoId', groupsCtrl.removeItemFromGroup);

/** Exclusiones */
router.get('/groups/:id/exclusions', groupsCtrl.getExclusions);
router.post('/groups/:id/exclusions', groupsCtrl.addExclusions);
router.delete('/groups/:id/exclusions', groupsCtrl.removeExclusions);

/* ================== CRUD MANUAL INSUMOS ================== */
router.get('/', ctrl.listar);
router.put('/:id', ctrl.actualizar);
router.delete('/:id', ctrl.eliminar);

/* ================== BULK (JSON / CSV) ================== */
router.post('/bulk', ctrl.bulkUpsert);
router.post('/bulk-csv', upload.single('file'), ctrl.bulkUpsertCSV);

/* ================== MANTENIMIENTO / UTILIDADES ================== */
router.post('/admin/cleanup-null', ctrl.__cleanupNullInsumos);
router.post('/sync-compras', ctrl.syncDesdeCompras);

module.exports = router;
