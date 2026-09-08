// routes/insumosRoutes.js
const router = require('express').Router();
const multer = require('multer');
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },  // 20MB para paired (dos archivos)
});

// ✅ CONTROLADOR UNIFICADO Y OPTIMIZADO
const ctrl = require('../controllers/insumosController');
const { authRequired } = require('../middleware/authMiddleware');

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
router.put('/rubros/rename', ctrl.renombrarRubro);

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

/* ================== IMPORT PAIRED + PREVIEW (rutas específicas antes de CRUD) ================== */
router.post(
  '/import-csv-paired',
  upload.fields([
    { name: 'rubros', maxCount: 1 },
    { name: 'insumos', maxCount: 1 },
  ]),
  ctrl.importCsvPaired
);

router.post(
  '/preview-columns',
  authRequired,
  upload.single('file'),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ ok: false, error: 'file_required' });
    try {
      const XLSX = require('xlsx');
      const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
      const columnas = rows.length ? Object.keys(rows[0]).filter(k => !k.startsWith('__EMPTY')) : [];
      const muestra = rows.slice(0, 5);
      return res.json({ ok: true, columnas, muestra });
    } catch (e) {
      return res.status(400).json({ ok: false, error: e.message });
    }
  }
);

/* ================== REEMPLAZAR INSUMO ================== */

router.get('/:id/reemplazar-preview', ctrl.reemplazarPreview);
router.post('/:id/reemplazar', ctrl.reemplazarInsumo);

/* ================== DESPERDICIO ================== */

router.put('/:id/desperdicio-override', ctrl.setDesperdicioOverride);

/* ================== MERMAS ================== */

router.get('/:id/mermas', ctrl.mermas_list);
router.post('/:id/mermas', ctrl.mermas_create);
router.put('/:id/mermas/:mermaId', ctrl.mermas_update);
router.delete('/:id/mermas/:mermaId', ctrl.mermas_remove);
router.get('/:id/mermas/:mermaId/aplicar-preview', ctrl.mermasAplicarPreview);
router.post('/:id/mermas/:mermaId/aplicar', ctrl.mermasAplicar);

/* ================== EQUIVALENCIAS ================== */
router.get('/:id/equivalencias', ctrl.equivalencias_list);
router.post('/:id/equivalencias', ctrl.equivalencias_create);
router.put('/:id/equivalencias/:eqId', ctrl.equivalencias_update);
router.delete('/:id/equivalencias/:eqId', ctrl.equivalencias_remove);

/* ================== BONIFICACIONES ================== */
router.get('/:id/bonificacion/estado', ctrl.estadoBonificacion);
router.post('/:id/bonificacion/aplicar', ctrl.aplicarBonificacion);
router.post('/:id/bonificacion/descartar', ctrl.descartarBonificacion);

/* ================== USO (recetas donde se usa el insumo) ================== */
router.get('/:id/uso', ctrl.usoInsumo);
router.put('/:id/uso/:itemId/merma', ctrl.usoInsumoCambiarMerma);

/* ================== CRUD MANUAL INSUMOS ================== */
router.post('/', ctrl.crearManual);
router.get('/', ctrl.listar);
router.get('/:id/compras', ctrl.getCompras);
router.get('/search-padrino', ctrl.searchPadrinoInsumo);
router.delete('/:id/manual', ctrl.eliminarManual);
router.put('/:id', ctrl.actualizar);
router.delete('/:id', ctrl.eliminar);

/* ================== BULK (JSON / CSV) ================== */
router.post('/bulk', ctrl.bulkUpsert);
router.post('/bulk-csv', upload.single('file'), ctrl.bulkUpsertCSV);

/* ================== BATCHES DE SUBIDA MANUAL ================== */
router.get('/batches', ctrl.listBatchesInsumos);
router.get('/batches/:batchId/preview', ctrl.previewBatchInsumos);
router.delete('/batches/:batchId', ctrl.deleteBatchInsumos);

// GET individual — al final, después de todas las estáticas, para no capturarlas
router.get('/:id', ctrl.getOne);

/* ================== MANTENIMIENTO / UTILIDADES ================== */
router.post('/admin/cleanup-null', ctrl.__cleanupNullInsumos);
router.post('/sync-compras', ctrl.syncDesdeCompras);

module.exports = router;