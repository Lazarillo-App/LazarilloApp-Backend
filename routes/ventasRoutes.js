// routes/ventasRoutes.js
const express = require('express');
const router = express.Router();

const authRequired = require('../middleware/authMiddleware');   // ✅ función
const ventasCtrl   = require('../controllers/ventasController'); // ✅ objeto con funciones

// (debug defensivo — opcional, te ayuda si vuelve a fallar)
if (typeof authRequired !== 'function') {
  console.warn('[ventasRoutes] authRequired NO es función:', authRequired);
}
if (typeof ventasCtrl?.getVentas !== 'function') {
  console.warn('[ventasRoutes] getVentas NO es función');
}
if (typeof ventasCtrl?.ping !== 'function') {
  console.warn('[ventasRoutes] ping NO es función');
}

router.get('/ping', ventasCtrl.ping);
router.get('/', authRequired, ventasCtrl.getVentas);

module.exports = router;
