// routes/purchasesRoutes.js
'use strict';
const router = require('express').Router();
const ctrl   = require('../controllers/purchasesController');

router.post('/sync',           ctrl.sync);           // sincronizar rango desde MaxiRest
router.post('/sync-suppliers', ctrl.syncSuppliers);  // sync solo proveedores
router.get('/suppliers',       ctrl.listSuppliers);  // listar proveedores
router.get('/export/csv',      ctrl.exportCsv);      // descargar CSV (antes que /)
router.get('/summary',         ctrl.summary);        // totales por proveedor
router.get('/',                ctrl.list);           // listado con filtros y paginacion

module.exports = router;