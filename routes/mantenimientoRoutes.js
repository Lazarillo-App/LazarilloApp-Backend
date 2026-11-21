// routes/mantenimientoRoutes.js — Operación › Mantenimiento (ver services/mantenimiento.js)
// Monta en: app.use('/api/businesses/:businessId/mantenimiento', mantenimientoRoutes)
'use strict';
const router = require('express').Router({ mergeParams: true });
const svc = require('../services/mantenimiento');
const { ErrorProduccion } = require('../services/produccion');

const r = (fn) => async (req, res, next) => {
  try {
    res.json({ ok: true, ...(await fn(req)) });
  } catch (e) {
    if (e instanceof ErrorProduccion) return res.status(e.status).json({ ok: false, error: e.code, message: e.message });
    console.error('[mantenimiento]', req.method, req.originalUrl, e);
    next(e);
  }
};

router.get('/contexto', r(svc.contexto));
router.get('/equipos', r(svc.listarEquipos));
router.post('/equipos', r(svc.guardarEquipo));
router.get('/equipos/:equipoId', r(svc.detalleEquipo));
router.put('/equipos/:equipoId', r(svc.guardarEquipo));
router.delete('/equipos/:equipoId', r(svc.borrarEquipo));
router.post('/equipos/:equipoId/planes', r(svc.guardarPlan));
router.put('/equipos/:equipoId/planes/:planId', r(svc.guardarPlan));
router.delete('/equipos/:equipoId/planes/:planId', r(svc.borrarPlan));
router.get('/ordenes', r(svc.listarOrdenes));
router.post('/ordenes', r(svc.crearOrden));
router.post('/fallas', r(svc.reportarFalla));
router.post('/ordenes/:ordenId/:accion', r(svc.accionOrden));
router.get('/registros', r(svc.listarRegistros));
router.post('/registros', r(svc.crearRegistro));
router.delete('/registros/:registroId', r(svc.borrarRegistro));

module.exports = router;
