// routes/insumosRoutes.js
const router = require('express').Router();
const ctrl = require('../controllers/insumosController');
const multer = require('multer');
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
// ✅ ORDEN CORRECTO: más específicas primero

// Items bulk (MÁS ESPECÍFICA)
router.post('/groups/:groupId/items/bulk', ctrl.addMultipleItemsToGroup);

// Items individuales (MENOS ESPECÍFICA)
router.post('/groups/:groupId/items', ctrl.addItemToGroup);
router.delete('/groups/:groupId/items/:insumoId', ctrl.removeItemFromGroup);

// Grupos CRUD
router.get('/groups', groupsCtrl.list);
router.get('/groups/:id', groupsCtrl.getOne);
router.post('/groups', groupsCtrl.create);
router.put('/groups/:id', groupsCtrl.update);
router.delete('/groups/:id', groupsCtrl.remove);

// ⚠️ ESTAS RUTAS ENTRAN EN CONFLICTO - Comentá las del groupsCtrl
// router.put('/groups/:id/items', groupsCtrl.replaceItems);   // ❌ Conflicto con bulk
// router.post('/groups/:id/items', groupsCtrl.addItem);       // ❌ Conflicto con individual

/* ================== EXCLUSIONES (TODO System) ================== */
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
