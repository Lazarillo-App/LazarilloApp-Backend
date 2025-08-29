// routes/authRoutes.js
const router = require('express').Router();
const authCtrl = require('../controllers/authController');
const authRequired = require('../middleware/authMiddleware');

router.post('/register', authCtrl.register);
router.post('/login',    authCtrl.login);
router.get('/me',        authRequired, authCtrl.me);
router.put('/me',        authRequired, authCtrl.updateMe);

module.exports = router;
