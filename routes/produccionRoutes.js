// routes/produccionRoutes.js — Tareas operativas · producción (ver services/produccion.js)
// Monta en: app.use('/api/businesses/:businessId/produccion', produccionRoutes)
'use strict';
const router = require('express').Router({ mergeParams: true });
const svc = require('../services/produccion');
const reg = require('../services/produccionRegistros');
const sug = require('../services/produccionSugerencias');

const r = (fn) => async (req, res, next) => {
  try {
    const out = await fn(req);
    res.json({ ok: true, ...(Array.isArray(out) ? { items: out } : out) });
  } catch (e) {
    if (e instanceof svc.ErrorProduccion) return res.status(e.status).json({ ok: false, error: e.code, message: e.message });
    console.error('[produccion]', req.method, req.originalUrl, e);
    next(e);
  }
};

router.get('/contexto', r(svc.contexto));
router.put('/equipo/:userId/areas', r(svc.asignarAreas));
router.post('/turnos', r(svc.guardarTurno));
router.put('/turnos/:turnoId', r(svc.guardarTurno));
router.delete('/turnos/:turnoId', r(svc.borrarTurno));
router.get('/elaborados', r(svc.elaborados));
router.get('/insumos', r(svc.buscarInsumos));
router.put('/elaborados/:insumoId', r(svc.guardarElaborado));
router.get('/tareas', r(svc.listarTareas));
router.post('/tareas', r(svc.crearTareas));
router.post('/semana/copiar', r(svc.copiarSemana));
router.get('/cambios', r(svc.cambiosPendientes));
router.get('/panel', r(svc.panel));
// Etapa 2: mise en place, mermas, desperdicios y consumos
router.get('/mise', r(reg.listarMise));
router.put('/mise/:plazaId', r(reg.guardarMise));
router.get('/mermas', r(reg.listarMermas));
router.post('/mermas', r(reg.crearMerma));
router.get('/mermas/insumo/:insumoId', r(reg.mermaDeInsumo));
router.get('/desperdicios', r(reg.listarDesperdicios));
router.post('/desperdicios', r(reg.crearDesperdicio));
router.delete('/registros/:tipo/:id', r(reg.borrarRegistro));
router.get('/consumos', r(reg.consumos));
router.get('/sugerencias', r(sug.sugerencias));
router.get('/tareas/:id', r(svc.detalle));
router.patch('/tareas/:id', r(svc.editarTarea));
router.delete('/tareas/:id', r(svc.borrarTarea));
router.post('/tareas/:id/notas', r(svc.nota));
router.post('/tareas/:id/escalar', r(svc.escalar));
router.post('/tareas/:id/insumos', r(svc.agregarInsumo));
router.patch('/tareas/:id/insumos/:itemId', r(svc.editarInsumo));
router.post('/tareas/:id/insumos/:itemId/decision', r(svc.decidir));
router.post('/tareas/:id/:accion', r(svc.accion));

module.exports = router;
