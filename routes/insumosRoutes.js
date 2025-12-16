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
// POST /api/insumos/maxi-sync  → sincroniza insumos desde Maxi a tabla `insumos`
router.post('/maxi-sync', ctrl.syncFromMaxi);      // 👈 SIN paréntesis

// GET  /api/insumos/maxi      → lista insumos espejo Maxi (si lo usás)
router.get('/maxi', ctrl.listarMaxi);

/* ================== Maxi: RUBROS DE INSUMOS ================== */
// POST /api/insumos/maxi/rubros/sync → sincroniza rubros de insumos desde Maxi a `insumo_rubros`
router.post('/maxi/rubros/sync', ctrl.syncRubrosFromMaxi);

// GET  /api/insumos/maxi/rubros      → lista rubros de insumos guardados para el negocio
router.get('/maxi/rubros', ctrl.listarRubrosMaxi);

/* ================== CRUD MANUAL INSUMOS ================== */
// GET  /api/insumos
router.get('/', ctrl.listar);

// PUT  /api/insumos/:id
router.put('/:id', ctrl.actualizar);

// DELETE /api/insumos/:id
router.delete('/:id', ctrl.eliminar);

/* ================== BULK (JSON / CSV) ================== */
// POST /api/insumos/bulk
router.post('/bulk', ctrl.bulkUpsert);

// POST /api/insumos/bulk-csv  (campo "file")
router.post('/bulk-csv', upload.single('file'), ctrl.bulkUpsertCSV);

/* ================== MANTENIMIENTO / UTILIDADES ================== */
// POST /api/insumos/admin/cleanup-null
router.post('/admin/cleanup-null', ctrl.__cleanupNullInsumos);

// (opcional) sync desde compras
router.post('/sync-compras', ctrl.syncDesdeCompras);

/* ================== AGRUPACIONES DE INSUMOS ================== */
// GET    /api/insumos/groups
router.get('/groups', groupsCtrl.list);

// GET    /api/insumos/groups/:id
router.get('/groups/:id', groupsCtrl.getOne);

// POST   /api/insumos/groups
router.post('/groups', groupsCtrl.create);

// PUT    /api/insumos/groups/:id
router.put('/groups/:id', groupsCtrl.update);

// PUT    /api/insumos/groups/:id/items  -> reemplaza TODOS los ítems (bulk)
router.put('/groups/:id/items', groupsCtrl.replaceItems);

// POST   /api/insumos/groups/:id/items -> agrega UN insumo a la agrupación
router.post('/groups/:id/items', groupsCtrl.addItem);

// DELETE /api/insumos/groups/:id
router.delete('/groups/:id', groupsCtrl.remove);

// backend/routes/insumos.js
router.post('/groups/:groupId/items/bulk', ctrl.addMultipleItemsToGroup);  
router.post('/groups/:groupId/items', ctrl.addItemToGroup);               
router.delete('/groups/:groupId/items/:insumoId', ctrl.removeItemFromGroup);

/* ================== EXCLUSIONES (TODO System) ================== */
// GET    /api/insumos/groups/:id/exclusions
router.get('/groups/:id/exclusions', groupsCtrl.getExclusions);

// POST   /api/insumos/groups/:id/exclusions
router.post('/groups/:id/exclusions', groupsCtrl.addExclusions);

// DELETE /api/insumos/groups/:id/exclusions
router.delete('/groups/:id/exclusions', groupsCtrl.removeExclusions);

module.exports = router;
