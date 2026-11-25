// routes/mantenimientoRoutes.js — Operación › Mantenimiento (ver services/mantenimiento.js)
// Monta en: app.use('/api/businesses/:businessId/mantenimiento', mantenimientoRoutes)
'use strict';
const router = require('express').Router({ mergeParams: true });
const svc = require('../services/mantenimiento');
const { ErrorProduccion, _ctx } = require('../services/produccion');
const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cloudinary = require('../config/cloudinary');

const uploadMantFoto = multer({
  storage: new CloudinaryStorage({
    cloudinary,
    params: async (req) => ({
      folder: `lazarillo/cocina/${Number(req.params.businessId) || 'general'}`,
      allowed_formats: ['jpg', 'png', 'jpeg', 'webp', 'pdf'], // pdf: certificados del service (usuaria 25/11/2026)
      transformation: [{ width: 1200, height: 1200, crop: 'limit', quality: 'auto' }],
      public_id: `mant_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    }),
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /^image\/(png|jpe?g|webp)$/i.test(file.mimetype) || file.mimetype === 'application/pdf';
    if (!ok) return cb(new ErrorProduccion(400, 'formato_invalido', 'Solo fotos (JPG, PNG, WEBP) o PDF, hasta 8 MB'));
    cb(null, true);
  },
});

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
// Mantenimiento hecho antes de usar Lazarillo (usuaria 25/11/2026): va directo al historial.
router.post('/historico', r(svc.cargarHistorico));
router.post('/ordenes/:ordenId/:accion', r(svc.accionOrden));
router.get('/registros', r(svc.listarRegistros));
router.post('/registros', r(svc.crearRegistro));
router.delete('/registros/:registroId', r(svc.borrarRegistro));
router.post('/foto', r(async (req) => {
  await _ctx.contextoDe(req);
  await new Promise((resolve, reject) => {
    uploadMantFoto.single('file')(req, null, (err) => {
      if (!err) return resolve();
      if (err instanceof ErrorProduccion) return reject(err);
      if (err.code === 'LIMIT_FILE_SIZE') return reject(new ErrorProduccion(400, 'archivo_grande', 'La foto supera el máximo de 8 MB'));
      return reject(err);
    });
  });
  if (!req.file) throw new ErrorProduccion(400, 'falta_archivo', 'Elegí o sacá una foto, o subí el PDF');
  return { url: req.file.path, public_id: req.file.filename };
}));

module.exports = router;
