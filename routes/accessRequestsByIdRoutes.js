// routes/accessRequestsByIdRoutes.js
// Monta en: app.use('/api/access-requests', accessRequestsByIdRoutes)
'use strict';

const router = require('express').Router();
const ctrl = require('../controllers/branchAccessController');
const { authRequired } = require('../middleware/authMiddleware');

router.post('/:requestId/approve', authRequired, ctrl.approveRequest);
router.post('/:requestId/reject', authRequired, ctrl.rejectRequest);

module.exports = router;
