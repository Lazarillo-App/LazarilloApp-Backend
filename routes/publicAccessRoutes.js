// routes/publicAccessRoutes.js
// Monta en: app.use('/api/public/access', publicAccessRoutes) — SIN auth,
// es el flujo de alta por QR (Vista Operación).
'use strict';

const router = require('express').Router();
const ctrl = require('../controllers/branchAccessController');

router.get('/:code', ctrl.resolveCode);
router.post('/:code/request', ctrl.requestAccess);
router.post('/:code/confirm', ctrl.confirmAccess);

module.exports = router;
