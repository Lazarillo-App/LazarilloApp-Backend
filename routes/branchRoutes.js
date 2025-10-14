const router = require('express').Router();
const { authRequired, loadActiveBusiness } = require('../middleware/authMiddleware');
const branches = require('../controllers/branchController');

router.get('/',    authRequired, branches.list);   // usa X-Business-Id
router.post('/',   authRequired, branches.create);

module.exports = router;
