// routes/placesRoutes.js
const router = require('express').Router();
const { search, geocode } = require('../controllers/placesController');

router.get('/search', search);
router.get('/geocode', geocode);

module.exports = router;
