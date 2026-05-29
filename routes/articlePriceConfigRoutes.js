// routes/articlePriceConfigRoutes.js
'use strict';

const express = require('express');
const router  = express.Router({ mergeParams: true });
const ctrl    = require('../controllers/articlePriceConfigController');
const { authRequired }           = require('../middleware/authMiddleware');
const { requireBusinessAccessParam } = require('../middleware/requireBusinessAccess');

router.use(authRequired);
router.param('businessId', requireBusinessAccessParam);

// GET  /api/businesses/:businessId/recetas-costos
// Devuelve { costos: { [articleId]: { costoTotal, porciones, tieneAlerta, insumosAlerta } } }
router.get('/:businessId/recetas-costos', ctrl.getRecetasCostos);

// GET  /api/businesses/:businessId/recetas-alertas
// Devuelve lista de insumos con compras vencidas usados en recetas
router.get('/:businessId/recetas-alertas', ctrl.getRecetasAlertas);

// GET  /api/businesses/:businessId/article-price-config
// Devuelve byArticle, byRubro, byAgrupacion
router.get('/:businessId/article-price-config', ctrl.getPriceConfig);

// POST /api/businesses/:businessId/article-price-config
// Body: { scope, scopeId, objetivo?, precioManual?, articleIds? }
router.post('/:businessId/article-price-config', ctrl.savePriceConfig);

// DELETE /api/businesses/:businessId/article-price-config
// Body: { scope, scopeId }
router.delete('/:businessId/article-price-config', ctrl.deletePriceConfig);

// POST /api/businesses/:businessId/article-price-config/bulk
// Body: { configs: [ { scope, scopeId, objetivo?, precioManual?, articleIds? } ] }
router.post('/:businessId/article-price-config/bulk', ctrl.bulkSavePriceConfig);

module.exports = router;