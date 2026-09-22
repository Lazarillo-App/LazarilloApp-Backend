// routes/sectoresRoutes.js
// Monta en: app.use('/api/businesses/:businessId/sectores', sectoresRouter)
'use strict';

const router = require('express').Router({ mergeParams: true });
const ctrl = require('../controllers/sectoresController');

router.get('/', ctrl.listSectores);
router.post('/', ctrl.createSector);

module.exports = router;
