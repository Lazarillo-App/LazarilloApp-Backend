// routes/auditLogRoutes.js
'use strict';

const express = require('express');
const router  = express.Router({ mergeParams: true });
const ctrl    = require('../controllers/auditLogController');
const { authRequired }                = require('../middleware/authMiddleware');
const { requireBusinessAccessParam }  = require('../middleware/requireBusinessAccess');

router.use(authRequired);
router.param('businessId', requireBusinessAccessParam);

// GET /api/businesses/:businessId/audit-log
// Historial de actividad del equipo (owner/admin). Query: entityType?, userId?, before?, limit?
router.get('/:businessId/audit-log', ctrl.listAuditLog);

module.exports = router;
