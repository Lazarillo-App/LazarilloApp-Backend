// routes/auth.routes.js
const express = require('express');
const router = express.Router();

const authCtrl = require('../controllers/authController');
const auth     = require('../middleware/authMiddleware');

// Público
router.post('/register',        authCtrl.register);
router.post('/login',           authCtrl.login);
router.post('/forgot-password', authCtrl.requestPasswordReset);
router.post('/reset-password',  authCtrl.resetPassword);

// Protegido
router.get('/me',  auth, authCtrl.me);
router.put('/me',  auth, authCtrl.updateMe);

// (Opcional) si tenés estos handlers implementados:
if (typeof authCtrl.logout === 'function') {
  router.post('/logout', auth, authCtrl.logout);
}
if (typeof authCtrl.refresh === 'function') {
  router.post('/refresh', authCtrl.refresh); // público si usa refresh token httpOnly
}

module.exports = router;
