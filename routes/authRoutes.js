const router = require('express').Router();
const auth = require('../controllers/authController');
const { authRequired } = require('../middleware/authMiddleware');

router.post('/register', auth.register);
router.post('/login', auth.login);
router.get('/me', authRequired, auth.me);
router.put('/me', authRequired, auth.updateMe);

module.exports = router;
