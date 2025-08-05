// agrupacionesRoutes.js
const express = require('express');
const router = express.Router();
const {
  crearAgrupacion,
  obtenerAgrupaciones,
  editarAgrupacion,
  eliminarAgrupacion
} = require('../controllers/agrupacionesController');

router.post('/agrupaciones', crearAgrupacion);
router.get('/agrupaciones', obtenerAgrupaciones);
router.put('/agrupaciones/:id', editarAgrupacion);
router.delete('/agrupaciones/:id', eliminarAgrupacion);

module.exports = router;