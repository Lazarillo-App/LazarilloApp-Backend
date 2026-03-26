// backend/routes/insumosElaborados.js
/**
 * Rutas para gestionar insumos elaborados
 */

const express = require('express');
const router = express.Router();
const controller = require('../controllers/insumosElaboradosController');

// Middleware de autenticación (ajustar según tu implementación)
const { requireAuth, requireBusiness } = require('../middleware/auth');

// Aplicar middlewares a todas las rutas
router.use(requireAuth);
router.use(requireBusiness);

// ===== GESTIÓN DE INSUMOS ELABORADOS =====

// Marcar/desmarcar insumo individual como elaborado
router.patch('/:id/elaborado', controller.toggleInsumoElaborado);

// Marcar/desmarcar múltiples insumos como elaborados
router.post('/elaborado/bulk', controller.toggleInsumosElaboradosBulk);

// Listar todos los insumos elaborados
router.get('/elaborados', controller.listInsumosElaborados);

// Obtener estadísticas de insumos elaborados
router.get('/elaborados/stats', controller.getElaboradosStats);

// Mover todos los elaborados a un grupo
router.post('/elaborados/mover-a-grupo', controller.moverElaboradosAGrupo);

// ===== GESTIÓN DE RECETAS DE INSUMOS =====

// Obtener receta de un insumo
router.get('/:id/receta', controller.getInsumoReceta);

// Guardar/actualizar receta de un insumo
router.post('/:id/receta', controller.saveInsumoReceta);

// Eliminar receta de un insumo
router.delete('/:id/receta', controller.deleteInsumoReceta);

module.exports = router;