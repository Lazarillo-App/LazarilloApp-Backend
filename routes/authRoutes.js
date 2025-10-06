const express = require('express');
const router = express.Router();
const authCtrl = require('../controllers/authController');

router.post('/register', authCtrl.register);
router.post('/login',    authCtrl.login);
router.get('/me',        require('../middleware/authMiddleware'), authCtrl.me);
router.put('/me',        require('../middleware/authMiddleware'), authCtrl.updateMe);

router.post('/forgot-password', authCtrl.requestPasswordReset);
router.post('/reset-password',  authCtrl.resetPassword);

module.exports = router;
