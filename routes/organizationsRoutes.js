// routes/organizationsRoutes.js
const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/organizationsController');
const { authRequired } = require('../middleware/authMiddleware');

// Todas las rutas requieren auth
router.use(authRequired);

// Mi organización (basada en active_business_id)
router.get('/me/organization', ctrl.getMyOrganization);

// CRUD organización
router.post(  '/organizations',                                      ctrl.createOrganization);
router.get(   '/organizations/:orgId',                               ctrl.getOrganization);
router.patch( '/organizations/:orgId',                               ctrl.updateOrganization);

// Sub-negocio desde agrupación
router.post(  '/organizations/:orgId/businesses/from-group',         ctrl.createBusinessFromGroup);

module.exports = router;