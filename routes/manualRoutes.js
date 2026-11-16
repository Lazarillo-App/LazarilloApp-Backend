// routes/manualRoutes.js — montado en /api/manual (authRequired en app.js).
// Lectura del Manual de Lazarillo para cualquier usuario con sesión. La escritura está en
// /api/superusuarios/manual (solo super usuarios).
const router = require('express').Router();
const manual = require('../services/manualService');

router.get('/', async (_req, res, next) => {
  try { res.json({ ok: true, ...(await manual.listar()) }); } catch (e) { next(e); }
});
router.get('/:id', async (req, res, next) => {
  try {
    const c = await manual.leer(req.params.id);
    if (!c || !c.publicado) return res.status(404).json({ ok: false, error: 'no_encontrado' });
    res.json({ ok: true, capitulo: c });
  } catch (e) { next(e); }
});

module.exports = router;
