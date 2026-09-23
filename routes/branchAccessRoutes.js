// routes/branchAccessRoutes.js
// Monta en: app.use('/api/businesses/:businessId', branchAccessRoutes) — antes
// del guard global de /api, por eso cada ruta trae su propio authRequired
// (mismo criterio que accessRoutes.js).
'use strict';

const router = require('express').Router({ mergeParams: true });
const ctrl = require('../controllers/branchAccessController');
const { authRequired } = require('../middleware/authMiddleware');

router.get('/branches/:branchId/access', authRequired, ctrl.getOrCreateAccessCode);
router.patch('/branches/:branchId/access', authRequired, ctrl.setAccessCodeActive);

router.get('/access-requests', authRequired, ctrl.listPendientes);

module.exports = router;
