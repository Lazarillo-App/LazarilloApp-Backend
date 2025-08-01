const express = require('express');
const router = express.Router();
const {
  crearRubro,
  obtenerRubros,
  actualizarRubro,
  eliminarRubro,
  crearSubrubro,
  obtenerSubrubroPorId,
  obtenerSubrubros,
  eliminarSubrubro,
  obtenerSubrubrosPorRubro 
} = require('../controllers/agrupacionesController');

// 🟢 Rutas para rubros
router.post('/rubro', crearRubro);
router.get('/rubros', obtenerRubros);
router.put('/rubro/:id', actualizarRubro);
router.delete('/rubro/:id', eliminarRubro);

// 🔵 Rutas para subrubros
router.post('/subrubros', crearSubrubro);
router.get('/subrubros', obtenerSubrubros);
router.get('/subrubros/:id', obtenerSubrubroPorId);
router.delete('/subrubros/:id', eliminarSubrubro);
router.get('/subrubros/por-rubro/:rubroId', obtenerSubrubrosPorRubro);

module.exports = router;