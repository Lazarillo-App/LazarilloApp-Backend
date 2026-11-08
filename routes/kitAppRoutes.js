// routes/kitAppRoutes.js
// ⚙ Configuración › Conexiones (Diego, 08/11/2026): las PC vinculadas del negocio y su
// "Desvincular". Solo dueño/admin.
//   GET  /api/businesses/:businessId/kit/pcs
//   POST /api/businesses/:businessId/kit/pcs/:pcId/desvincular
//   GET  /api/businesses/:businessId/kit/version     última versión del kit (+ si podés publicar)
//   GET  /api/businesses/:businessId/kit/instalador  el zip "Lazarillo - instalar" (Diego, 08/11:
//        "el kit quiero bajarlo desde lazarillo"), con lz_api.txt apuntando a este servidor
//   POST /api/businesses/:businessId/kit/publicar    (equipo de Lazarillo) sube una versión nueva
'use strict';

const express = require('express');
const router = express.Router({ mergeParams: true });
const { requireBusinessAccess } = require('../middleware/requireBusinessAccess');
const multer = require('multer');
const kit = require('../services/kit/kitPcs');
const versiones = require('../services/kit/versiones');

const subida = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1 } });

// La dirección que va en lz_api.txt: la pública de este servicio (Render pone https y el host).
function urlPublica(req) {
  return process.env.KIT_API_URL || `${req.protocol}://${req.get('host')}`;
}

const PUEDEN = new Set(['owner', 'admin', 'service']);

function soloAdmin(req, res, next) {
  if (!PUEDEN.has(req.businessRole)) return res.status(403).json({ error: 'forbidden', need: 'admin' });
  next();
}

router.get('/pcs', requireBusinessAccess, soloAdmin, async (req, res, next) => {
  try {
    const pcs = await kit.listarPcs(Number(req.businessId));
    res.set('Cache-Control', 'no-store');
    res.json({ pcs });
  } catch (e) { next(e); }
});

router.post('/pcs/:pcId/desvincular', requireBusinessAccess, soloAdmin, async (req, res, next) => {
  try {
    const ok = await kit.desvincular(Number(req.businessId), Number(req.params.pcId), req.user?.id ?? null);
    if (!ok) return res.status(404).json({ error: 'pc_no_encontrada' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.get('/version', requireBusinessAccess, soloAdmin, async (req, res, next) => {
  try {
    const v = await versiones.ultima();
    res.set('Cache-Control', 'no-store');
    res.json({ version: v ? { version: v.version, publicado: v.publicado_en, tamano: v.tamano, archivos: v.archivos, notas: v.notas } : null,
      puedePublicar: versiones.puedePublicar(req.user) });
  } catch (e) { next(e); }
});

router.get('/instalador', requireBusinessAccess, soloAdmin, async (req, res, next) => {
  try {
    const z = await versiones.zipParaDescargar(urlPublica(req));
    if (!z) return res.status(404).json({ error: 'todavia_no_hay_kit_publicado' });
    res.set('Cache-Control', 'no-store');
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', 'attachment; filename="Lazarillo - instalar.zip"');
    res.set('X-Kit-Version', z.version);
    res.send(z.buffer);
  } catch (e) { next(e); }
});

router.post('/publicar', requireBusinessAccess, (req, res, next) => {
  if (!versiones.puedePublicar(req.user)) return res.status(403).json({ error: 'solo_el_equipo_de_lazarillo' });
  next();
}, subida.single('zip'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'falta_el_zip' });
    const v = await versiones.publicar(req.file.buffer, req.user?.id ?? null, req.body?.notas);
    console.log(`[kit] version ${v.version} publicada por usuario ${req.user?.id} (${v.archivos} archivos, ${v.tamano} B)`);
    res.status(201).json({ ok: true, version: v });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

module.exports = router;
