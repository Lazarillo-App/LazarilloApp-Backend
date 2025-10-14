// routes/auth.routes.js
const express = require('express');
const router = express.Router();

const authCtrl = require('../controllers/authController');
// ⬇️ Import correcto (destructuring) desde authMiddleware
const { authRequired } = require('../middleware/authMiddleware');

// Público
router.post('/register',        authCtrl.register);
router.post('/login',           authCtrl.login);
router.post('/forgot-password', authCtrl.requestPasswordReset);
router.post('/reset-password',  authCtrl.resetPassword);

// Protegido
router.get('/me',  authRequired, authCtrl.me);
router.put('/me',  authRequired, authCtrl.updateMe);

// (Opcional) si tenés estos handlers implementados:
if (typeof authCtrl.logout === 'function') {
  router.post('/logout', authRequired, authCtrl.logout);
}
if (typeof authCtrl.refresh === 'function') {
  // público si usa refresh token httpOnly
  router.post('/refresh', authCtrl.refresh);
}

module.exports = router;

