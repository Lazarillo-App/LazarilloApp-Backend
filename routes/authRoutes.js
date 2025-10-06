// routes/authRoutes.js
const express = require('express');
const router = express.Router();
const authCtrl = require('../controllers/authController');
const authRequired = require('../middleware/authMiddleware');

// Todo con prefijo /auth para matchear el frontend (AuthAPI: /auth/*)
router.post('/auth/register', authCtrl.register);
router.post('/auth/login',    authCtrl.login);

router.get('/auth/me',        authRequired, authCtrl.me);
router.put('/auth/me',        authRequired, authCtrl.updateMe);

router.post('/auth/forgot-password', authCtrl.requestPasswordReset);
router.post('/auth/reset-password',  authCtrl.resetPassword);

module.exports = router;
