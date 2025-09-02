// routes/agrupacionesRoutes.js
const express = require('express');
const router = express.Router();

const {
  crearAgrupacion,
  obtenerAgrupaciones,
  actualizarAgrupacion,
  eliminarAgrupacion,
  agregarArticulosAgrupacion,
  eliminarArticuloDeAgrupacion,
  ensureTodoAgrupacion,
  listarExclusiones,
  upsertExclusiones,
  moveItemsBetweenGroups 
} = require('../controllers/agrupacionesController');

// --- Rutas sin :id ---
router.post('/agrupaciones', crearAgrupacion);
router.get('/agrupaciones', obtenerAgrupaciones);

// 👇 IMPORTANTE: esta va ANTES de las que tienen :id
router.put('/agrupaciones/todo', ensureTodoAgrupacion);

// --- Rutas con :id (sin regex, ordenadas luego de /todo) ---
router.put('/agrupaciones/:id', actualizarAgrupacion);
router.delete('/agrupaciones/:id', eliminarAgrupacion);

router.put('/agrupaciones/:id/articulos', agregarArticulosAgrupacion);
router.delete('/agrupaciones/:id/articulos/:articuloId', eliminarArticuloDeAgrupacion);

// Exclusiones
router.get('/agrupaciones/:id/exclusiones', listarExclusiones);
router.post('/agrupaciones/:id/exclusiones', upsertExclusiones);
router.post('/agrupaciones/:fromId/move-items', moveItemsBetweenGroups);
// routes/agrupacionesRoutes.js (temporal)
const pool = require('../config/db');

router.get('/agrupaciones/:id/_debug', async (req, res) => {
  const id = Number(req.params.id);
  try {
    const { rows } = await pool.query(`
      SELECT id,
             pg_typeof(articulos) AS tipo,
             LEFT(
               CASE
                 WHEN pg_typeof(articulos)::text = 'jsonb' THEN articulos::text
                 ELSE COALESCE(articulos, '')
               END, 400
             ) AS preview
      FROM agrupaciones WHERE id = $1
    `, [id]);
    res.json(rows[0] || null);
  } catch (e) {
    console.error('[_debug error]', e);
    res.status(500).json({ ok:false, error:e.message, code:e.code, detail:e.detail });
  }
});


module.exports = router;