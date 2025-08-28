const router = require('express').Router();
const { authRequired } = require('../middleware/authMiddleware');
const { loadActiveBusiness } = require('../middleware/business');
const biz = require('../controllers/businessController');

router.use(authRequired, loadActiveBusiness);

router.get('/', biz.listMine);
router.post('/', biz.create);
router.put('/:id', biz.update);
router.post('/:id/select', biz.setActive);

// Maxi creds
router.post('/:id/maxi-credentials', biz.saveMaxiCreds);
router.get('/:id/maxi-status', biz.maxiStatus);

module.exports = router;
