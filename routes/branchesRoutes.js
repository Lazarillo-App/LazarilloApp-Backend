// routes/branchesRoutes.js
// Monta en: app.use('/api/businesses/:bizId/branches', branchesRouter)
'use strict';

const router = require('express').Router({ mergeParams: true });
const ctrl   = require('../controllers/branchesController');

// has-branches ANTES de /:branchId para no colisionar
router.get('/has-branches', ctrl.hasBranches);

// main ANTES de /:branchId para no colisionar
router.patch('/main', ctrl.updateMainBranch);

// CRUD
router.get   ('/',            ctrl.listBranches);
router.get   ('/:branchId',   ctrl.getBranch);
router.post  ('/',            ctrl.createBranch);
router.patch ('/:branchId',   ctrl.updateBranch);
router.delete('/:branchId',   ctrl.deleteBranch);

module.exports = router;