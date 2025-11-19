const router = require('express').Router();
const ctrl = require('../controllers/insumosController');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// Maxi: sync + listado snapshot
router.post('/maxi-sync', ctrl.syncFromMaxi);  // POST /api/insumos/maxi-sync
router.get('/maxi', ctrl.listarMaxi);          // GET  /api/insumos/maxi

// CRUD manual
router.get('/', ctrl.listar);
router.post('/', ctrl.crearManual);
router.put('/:id', ctrl.actualizar);
router.delete('/:id', ctrl.eliminar);

// Bulk
router.post('/bulk', ctrl.bulkUpsert);
router.post('/bulk-csv', upload.single('file'), ctrl.bulkUpsertCSV);

// Mantenimiento
router.post('/admin/cleanup-null', ctrl.__cleanupNullInsumos);


// (opcional)
router.post('/sync-compras', ctrl.syncDesdeCompras);

module.exports = router;
