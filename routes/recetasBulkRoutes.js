// routes/recetasBulkRoutes.js
// Se monta en: /api/businesses/:businessId/recetas/...
const express = require('express');
const router = express.Router({ mergeParams: true });
const ctrl = require('../controllers/recetasBulkController');
const { authRequired } = require('../middleware/authMiddleware');

router.use(authRequired);

// GET /api/businesses/:businessId/recetas/bulk-preview
router.get('/bulk-preview', ctrl.previewBulkDelete);

// DELETE /api/businesses/:businessId/recetas/bulk
router.delete('/bulk', ctrl.bulkDelete);

// POST /api/businesses/:businessId/recetas/bulk-add-insumo
router.post('/bulk-add-insumo', ctrl.bulkAddInsumo);

module.exports = router;