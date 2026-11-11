// routes/placesRoutes.js
const router = require('express').Router();
const { search, geocode, photos } = require('../controllers/placesController');
const { completar } = require('../controllers/completarNegocioController');
const imagenes = require('../controllers/buscarImagenesController');

router.get('/search', search);
router.get('/geocode', geocode);
router.get('/photos', photos);
router.post('/completar', completar);
// Logo de un local sin web: búsqueda de imágenes (Brave) y bajada de la elegida.
router.get('/imagenes', imagenes.buscar);
router.get('/imagen', imagenes.bajar);

module.exports = router;
