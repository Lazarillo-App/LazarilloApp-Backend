const router = require('express').Router();
const { authRequired, loadActiveBusiness } = require('../middleware/authMiddleware'); 
const { requireBusinessAccess } = require('../middleware/requireBusinessAccess');
const branches = require('../controllers/branchController');

const requireBiz = (req, res, next) => requireBusinessAccess(req, res, next);

router.get('/',  authRequired, loadActiveBusiness, requireBiz, branches.list);
router.post('/', authRequired, loadActiveBusiness, requireBiz, branches.create);

module.exports = router;
