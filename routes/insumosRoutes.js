// routes/insumosRoutes.js
const router = require('express').Router();
const multer = require('multer');

// ✅ CONTROLADOR UNIFICADO Y OPTIMIZADO
const ctrl = require('../controllers/insumosController');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

/* ================== VISTAS Y ESTADÍSTICAS (NUEVAS) ================== */
// 🆕 Estas rutas son el espejo de agrupaciones
router.get('/tree-view', ctrl.getTreeView);  // Vista de árbol para sidebar
router.get('/stats', ctrl.getStats);         // Estadísticas generales

/* ================== Maxi: INSUMOS ================== */
router.post('/maxi-sync', ctrl.syncFromMaxi);
router.get('/maxi', ctrl.listarMaxi);

/* ================== Maxi: RUBROS DE INSUMOS ================== */
router.post('/maxi/rubros/sync', ctrl.syncRubrosFromMaxi);
router.get('/maxi/rubros', ctrl.listarRubrosMaxi);

/* ================== AGRUPACIONES DE INSUMOS ================== */
/** Rutas fijas primero */
router.post('/groups/create-or-move', ctrl.groups_createOrMove);

/** CRUD grupos */
router.get('/groups', ctrl.groups_list);
router.get('/groups/:id', ctrl.groups_getOne);
router.post('/groups', ctrl.groups_create);
router.put('/groups/:id', ctrl.groups_update);
router.delete('/groups/:id', ctrl.groups_remove);

/** Items */
router.post('/groups/:id/items/bulk', ctrl.groups_addMultiple);
router.put('/groups/:id/items', ctrl.groups_replaceItems);
router.post('/groups/:id/items', ctrl.groups_addItem);
router.delete('/groups/:id/items/:insumoId', ctrl.groups_removeItem);

/** Exclusiones */
router.get('/groups/:id/exclusions', ctrl.groups_getExclusions);
router.post('/groups/:id/exclusions', ctrl.groups_addExclusions);
router.delete('/groups/:id/exclusions', ctrl.groups_removeExclusions);

/* ================== CRUD MANUAL INSUMOS ================== */
router.post('/', ctrl.crearManual);  // Crear insumo manual
router.get('/', ctrl.listar);        // Listar con filtros avanzados
router.put('/:id', ctrl.actualizar);
router.delete('/:id', ctrl.eliminar);

/* ================== BULK (JSON / CSV) ================== */
router.post('/bulk', ctrl.bulkUpsert);
router.post('/bulk-csv', upload.single('file'), ctrl.bulkUpsertCSV);

/* ================== MANTENIMIENTO / UTILIDADES ================== */
router.post('/admin/cleanup-null', ctrl.__cleanupNullInsumos);
router.post('/sync-compras', ctrl.syncDesdeCompras);

module.exports = router;
