// routes/recetasElaboradosRoutes.js
const express = require('express');
const router  = express.Router({ mergeParams: true });
const ctrl    = require('../controllers/recetasElaboradosController');
const { authRequired } = require('../middleware/authMiddleware');

router.use(authRequired);

router.get('/',    ctrl.getRecetaElaborado);
router.post('/',   ctrl.saveRecetaElaborado);
router.delete('/', ctrl.deleteRecetaElaborado);

// GET/POST /api/businesses/:businessId/insumos/:insumoId/receta/observaciones
router.get('/observaciones', ctrl.listRecetaElaboradoObservaciones);
router.post('/observaciones', ctrl.addRecetaElaboradoObservacion);

module.exports = router;