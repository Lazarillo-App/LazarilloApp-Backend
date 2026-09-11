// routes/metodosCoccionRoutes.js
'use strict';

const express = require('express');
const router  = express.Router({ mergeParams: true });
const ctrl    = require('../controllers/metodosCoccionController');
const { authRequired }                = require('../middleware/authMiddleware');
const { requireBusinessAccessParam }  = require('../middleware/requireBusinessAccess');

router.use(authRequired);
router.param('businessId', requireBusinessAccessParam);

// GET  /api/businesses/:businessId/metodos-coccion
router.get('/:businessId/metodos-coccion', ctrl.list);

// POST /api/businesses/:businessId/metodos-coccion  { nombre }
router.post('/:businessId/metodos-coccion', ctrl.create);

module.exports = router;
