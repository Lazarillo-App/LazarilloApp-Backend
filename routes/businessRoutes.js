const express = require('express');
const router = express.Router();
const authRequired = require('../middleware/authMiddleware');
const businesses = require('../controllers/businessController');

router.get('/', authRequired, businesses.listMine);
router.get('/active', authRequired, businesses.getActive);
router.patch('/active', authRequired, businesses.setActive);
router.post('/', authRequired, businesses.create);
router.patch('/:id', authRequired, businesses.update);
router.get('/:id', authRequired, businesses.getOne);
router.post('/', authRequired, businesses.create);
router.post('/:id/select', authRequired, businesses.select);

router.get('/:id/maxi-status', authRequired, businesses.maxiStatus);
router.post('/:id/maxi-credentials', authRequired, businesses.maxiSave);
router.get('/:id/maxi-articles', authRequired, businesses.maxiArticles);

router.get('/:id',       authRequired, businesses.getOne);
router.patch('/:id',     authRequired, businesses.update);
router.delete('/:id',    authRequired, businesses.remove);

module.exports = router;
