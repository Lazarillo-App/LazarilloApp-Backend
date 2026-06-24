// routes/insumosRoutes.js
const router = require('express').Router();
const multer = require('multer');
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },  // 20MB para paired (dos archivos)
});

// ✅ CONTROLADOR UNIFICADO Y OPTIMIZADO
const ctrl = require('../controllers/insumosController');

/* ================== VISTAS Y ESTADÍSTICAS (NUEVAS) ================== */
router.get('/tree-view', ctrl.getTreeView);
router.get('/stats', ctrl.getStats);

/* ================== Maxi: INSUMOS ================== */
router.post('/maxi-sync', ctrl.syncFromMaxi);
router.get('/maxi', ctrl.listarMaxi);

/* ================== Maxi: RUBROS DE INSUMOS ================== */
router.post('/maxi/rubros/sync', ctrl.syncRubrosFromMaxi);
router.get('/maxi/rubros', ctrl.listarRubrosMaxi);
router.get('/rubros', ctrl.getRubrosInsumos);

/* ================== AGRUPACIONES DE INSUMOS ================== */
router.post('/groups/create-or-move', ctrl.groups_createOrMove);

router.get('/groups', ctrl.groups_list);
router.get('/groups/:id', ctrl.groups_getOne);
router.post('/groups', ctrl.groups_create);
router.put('/groups/:id', ctrl.groups_update);
router.delete('/groups/:id', ctrl.groups_remove);

router.post('/groups/:id/items/bulk', ctrl.groups_addMultiple);
router.put('/groups/:id/items', ctrl.groups_replaceItems);
router.post('/groups/:id/items', ctrl.groups_addItem);
router.delete('/groups/:id/items/:insumoId', ctrl.groups_removeItem);

router.get('/groups/:id/exclusions', ctrl.groups_getExclusions);
router.post('/groups/:id/exclusions', ctrl.groups_addExclusions);
router.delete('/groups/:id/exclusions', ctrl.groups_removeExclusions);

/* ================== CRUD MANUAL INSUMOS ================== */
router.post('/', ctrl.crearManual);
router.get('/', ctrl.listar);
router.put('/:id', ctrl.actualizar);
router.delete('/:id', ctrl.eliminar);

/* ================== IMPORT PAIRED (rubros + insumos) ================== */
router.post(
  '/import-csv-paired',
  upload.fields([
    { name: 'rubros', maxCount: 1 },
    { name: 'insumos', maxCount: 1 },
  ]),
  ctrl.importCsvPaired
);

/* ================== BULK (JSON / CSV) ================== */
router.post('/bulk', ctrl.bulkUpsert);
router.post('/bulk-csv', upload.single('file'), ctrl.bulkUpsertCSV);

/* ================== BATCHES DE SUBIDA MANUAL ================== */
router.get('/batches', ctrl.listBatchesInsumos);
router.get('/batches/:batchId/preview', ctrl.previewBatchInsumos);
router.delete('/batches/:batchId', ctrl.deleteBatchInsumos);

/* ================== MANTENIMIENTO / UTILIDADES ================== */
router.post('/admin/cleanup-null', ctrl.__cleanupNullInsumos);
router.post('/sync-compras', ctrl.syncDesdeCompras);

module.exports = router;