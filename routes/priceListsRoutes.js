'use strict';
const router = require('express').Router({ mergeParams: true });
const ctrl   = require('../controllers/priceListsController');
const { authRequired } = require('../middleware/authMiddleware');
const { requireBusinessAccessParam } = require('../middleware/requireBusinessAccess');

router.use(authRequired);

// ── Por organización ──────────────────────────────────────────────────────
router.get ('/organizations/:orgId/price-lists/config',               ctrl.getOrgPriceListConfig);
router.put ('/organizations/:orgId/price-lists/config',               ctrl.saveOrgPriceListConfig);
router.get ('/organizations/:orgId/price-lists/discount-exceptions',  ctrl.getDiscountExceptions);
router.post('/organizations/:orgId/price-lists/discount-exceptions',  ctrl.addDiscountException);
router.delete('/organizations/:orgId/price-lists/discount-exceptions', ctrl.removeDiscountException);

// ── Por negocio ──────────────────────────────────────────────────────────
router.param('businessId', requireBusinessAccessParam);
router.get('/businesses/:businessId/price-list',        ctrl.getBusinessPriceList);
router.put('/businesses/:businessId/price-list',        ctrl.setBusinessPriceList);
router.get('/businesses/:businessId/price-list/prices', ctrl.getBusinessPrices);

module.exports = router;