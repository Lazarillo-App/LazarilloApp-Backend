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

/* ================== AGRUPACIONES DE INSUMOS (UNIFICADO) ================== */
/**
 * Orden:
 * 1) Rutas fijas (sin :id)
 * 2) CRUD /groups
 * 3) Rutas con :id más específicas primero (bulk, exclusions)
 * 4) Luego items generales
 */

// 1) Ruta fija
router.post('/groups/create-or-move', groupsCtrl.createOrMove);

// 2) Grupos CRUD
router.get('/groups', groupsCtrl.list);
router.get('/groups/:id', groupsCtrl.getOne);
router.post('/groups', groupsCtrl.create);
router.put('/groups/:id', groupsCtrl.update);
router.delete('/groups/:id', groupsCtrl.remove);

// 3) Items bulk (elegí UNA sola)
// Si querés usar la que ya venías usando:
router.post('/groups/:id/items/bulk', groupsCtrl.addMultipleItemsToGroup);
// Si preferís usar addItemsBulk, entonces comentá la de arriba y dejá esta:
// router.post('/groups/:id/items/bulk', groupsCtrl.addItemsBulk);

// 4) Items generales
router.put('/groups/:id/items', groupsCtrl.replaceItems); // reemplazar set completo
router.post('/groups/:id/items', groupsCtrl.addItemToGroup); // agregar 1
router.delete('/groups/:id/items/:insumoId', groupsCtrl.removeItemFromGroup); // quitar 1

// 5) Exclusiones
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
