// routes/accessRoutes.js
'use strict';

const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/accessController');
const { authRequired } = require('../middleware/authMiddleware');
const requireAppAdmin  = require('../middleware/requireAppAdmin');

// ── Rutas de usuario autenticado ──────────────────────────────────────────────
router.get ('/status',  authRequired, ctrl.getStatus);
router.post('/redeem',  authRequired, ctrl.redeemCode);

// ── Rutas de admin ────────────────────────────────────────────────────────────
router.get   ('/admin/codes',              authRequired, requireAppAdmin, ctrl.listCodes);
router.post  ('/admin/codes',              authRequired, requireAppAdmin, ctrl.createCode);
router.delete('/admin/codes/:id',          authRequired, requireAppAdmin, ctrl.deactivateCode);
router.get   ('/admin/users',              authRequired, requireAppAdmin, ctrl.listUsers);
router.post  ('/admin/users/:id/activate', authRequired, requireAppAdmin, ctrl.activateUser);
router.post  ('/admin/users/:id/suspend',  authRequired, requireAppAdmin, ctrl.suspendUser);

module.exports = router;