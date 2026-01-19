/**
 * Rutas de divisiones (subnegocios)
 * Usa app_businesses con parent_id para jerarquía
 */

const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/divisionsController');

// GET /api/divisions/business/:businessId - Lista subnegocios de un negocio
router.get('/business/:businessId', ctrl.getDivisionsByBusiness);

// GET /api/divisions/business/:businessId/main - Obtener el negocio principal
router.get('/business/:businessId/main', ctrl.getMainDivision);

// GET /api/divisions/:divisionId - Obtener una división/subnegocio
router.get('/:divisionId', ctrl.getDivisionById);

// POST /api/divisions - Crear subnegocio
router.post('/', ctrl.createDivision);

// PUT /api/divisions/:divisionId - Actualizar subnegocio
router.put('/:divisionId', ctrl.updateDivision);

// DELETE /api/divisions/:divisionId - Eliminar subnegocio
router.delete('/:divisionId', ctrl.deleteDivision);

module.exports = router;