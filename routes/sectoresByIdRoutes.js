// routes/sectoresByIdRoutes.js
// Monta en: app.use('/api/sectores', sectoresByIdRouter)
'use strict';

const router = require('express').Router();
const ctrl = require('../controllers/sectoresController');

router.get('/:sectorId', ctrl.getSector);
router.patch('/:sectorId', ctrl.updateSector);
router.delete('/:sectorId', ctrl.deleteSector);

module.exports = router;
