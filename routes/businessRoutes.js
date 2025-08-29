const express = require('express');
const router = express.Router();
const authRequired = require('../middleware/authMiddleware');
const businesses = require('../controllers/businessController');

router.get('/',         authRequired, businesses.listMine);
router.get('/active',   authRequired, businesses.getActive);
router.patch('/active', authRequired, businesses.setActive);
router.post('/',        authRequired, businesses.create);
router.patch('/:id',    authRequired, businesses.update);
router.post('/',              authRequired, businesses.create);
router.post('/:id/select',    authRequired, businesses.select);

module.exports = router;
