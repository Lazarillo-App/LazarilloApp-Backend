const express = require('express');
const router = express.Router();

const authCtrl = require('../controllers/authController');
const { authRequired } = require('../middleware/authMiddleware');  

// Público
router.post('/register',        authCtrl.register);
router.post('/login',           authCtrl.login);
router.post('/forgot-password', authCtrl.requestPasswordReset);
router.post('/reset-password',  authCtrl.resetPassword);

// Protegido
router.get('/me',  authRequired, authCtrl.me);
router.put('/me',  authRequired, authCtrl.updateMe);

// Opcionales
if (typeof authCtrl.logout === 'function') {
  router.post('/logout', authRequired, authCtrl.logout);
}
if (typeof authCtrl.refresh === 'function') {
  router.post('/refresh', authCtrl.refresh);
}

module.exports = router;
