// routes/promocionesRoutes.js
const express = require('express');
const router = express.Router({ mergeParams: true });
const ctrl = require('../controllers/promocionesController');
const { authRequired } = require('../middleware/authMiddleware');
router.use(authRequired);
// POST /api/businesses/:businessId/promociones
router.post('/', ctrl.crearPromocion);
// PUT /api/businesses/:businessId/promociones/:promoId
router.put('/:promoId', ctrl.actualizarPromocion);
router.delete('/:promoId', ctrl.eliminarPromocion);
module.exports = router;