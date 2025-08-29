// routes/businessRoutes.js
const express = require('express');
const router = express.Router();

const authRequired = require('../middleware/authMiddleware'); // default
const businesses = require('../controllers/businessController');

router.get('/',        authRequired, businesses.listMine);
router.get('/active',  authRequired, businesses.getActive);
router.patch('/active',authRequired, businesses.setActive);

module.exports = router;
