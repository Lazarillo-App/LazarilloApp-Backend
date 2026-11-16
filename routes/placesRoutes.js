// routes/placesRoutes.js
const router = require('express').Router();
const { search, geocode, photos, direcciones } = require('../controllers/placesController');
const { completar } = require('../controllers/completarNegocioController');

router.get('/search', search);
router.get('/geocode', geocode);
router.get('/direcciones', direcciones);
router.get('/photos', photos);
router.post('/completar', completar);

module.exports = router;
