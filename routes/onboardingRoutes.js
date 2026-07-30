// routes/onboardingRoutes.js
// Rutas del Asistente de onboarding (Anthony). Alta masiva por JSON.
'use strict';

const express = require('express');
const router = express.Router({ mergeParams: true });

const ctrl = require('../controllers/onboardingController');
const { authRequired } = require('../middleware/authMiddleware');
const { requireBusinessAccess } = require('../middleware/requireBusinessAccess');

// POST /api/businesses/:businessId/onboarding/articulos-bulk
router.post(
  '/:businessId/onboarding/articulos-bulk',
  authRequired,
  (req, res, next) => requireBusinessAccess(req, res, next),
  ctrl.articulosBulk
);

module.exports = router;