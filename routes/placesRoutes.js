// routes/placesRoutes.js
const router = require('express').Router();
const { search, geocode, photos } = require('../controllers/placesController');

router.get('/search', search);
router.get('/geocode', geocode);
router.get('/photos', photos);

module.exports = router;
