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
 * Nota de orden:
 * - Primero rutas "fijas" (create-or-move)
 * - Luego rutas con :id
 * - Dentro de :id, primero las más específicas (bulk, exclusions) y luego las generales
 */

// Crear o mover por nombre (no lleva :id)
router.post('/groups/create-or-move', groupsCtrl.createOrMove);

// Grupos CRUD
router.get('/groups', groupsCtrl.list);
router.get('/groups/:id', groupsCtrl.getOne);
router.post('/groups', groupsCtrl.create);
router.put('/groups/:id', groupsCtrl.update);
router.delete('/groups/:id', groupsCtrl.remove);

// Items (mismo estilo que venís usando, pero ya en groupsCtrl)
router.post('/groups/:id/items/bulk', groupsCtrl.addMultipleItemsToGroup);
router.post('/groups/:id/items', groupsCtrl.addItemToGroup);
router.delete('/groups/:id/items/:insumoId', groupsCtrl.removeItemFromGroup); 

// (Opcional) Reemplazar items completo (si lo querés usar)
router.put('/groups/:id/items', groupsCtrl.replaceItems);

// Exclusiones
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
