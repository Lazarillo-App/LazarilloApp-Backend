// routes/ventasRoutes.js
const express = require('express');
const router = express.Router();
const { getVentas } = require('../controllers/ventasController');

router.get('/', getVentas);

module.exports = router;