// routes/meRoutes.js
const router = require('express').Router();
const { authRequired } = require('../middleware/authMiddleware');
const me = require('../controllers/meController');

router.get('/access',           authRequired, me.getAccess);
router.post('/active-business', authRequired, me.setActiveBusiness);

module.exports = router;