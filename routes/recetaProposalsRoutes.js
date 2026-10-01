// routes/recetaProposalsRoutes.js
// Monta en: app.use('/api/businesses/:businessId/receta-proposals', recetaProposalsRoutes)
'use strict';

const router = require('express').Router({ mergeParams: true });
const ctrl = require('../controllers/recetaProposalsController');

router.get('/', ctrl.listProposals);
router.get('/:id', ctrl.getProposal);
router.post('/:id/approve', ctrl.approveProposal);
router.post('/:id/reject', ctrl.rejectProposal);
router.post('/:id/revision', ctrl.requestRevision);

module.exports = router;
