// routes/insumosRoutes.js
const router = require('express').Router();
const ctrl = require('../controllers/insumosController');
const multer = require('multer');

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

// POST /api/insumos
router.post('/', ctrl.crearManual);

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

module.exports = router;
