// routes/kitAppRoutes.js
// ⚙ Configuración › Conexiones (Diego, 08/11/2026): las PC vinculadas del negocio y su
// "Desvincular". Solo dueño/admin.
//   GET  /api/businesses/:businessId/kit/pcs
//   POST /api/businesses/:businessId/kit/pcs/:pcId/desvincular
//   GET  /api/businesses/:businessId/kit/version     última versión del kit
//   GET  /api/businesses/:businessId/kit/instalador  el zip "Lazarillo - instalar" (Diego, 08/11:
//        "el kit quiero bajarlo desde lazarillo"), con lz_api.txt apuntando a este servidor
//   No hay "publicar" desde la app: el kit vive en el servidor (carpeta kit/ del repo, ver
//   services/kit/versiones.js), Diego 08/11: "no quiero que se publique desde usuario".
'use strict';

const express = require('express');
const router = express.Router({ mergeParams: true });
const { requireBusinessAccess } = require('../middleware/requireBusinessAccess');
const kit = require('../services/kit/kitPcs');
const versiones = require('../services/kit/versiones');

// La dirección que va en lz_api.txt: la pública de este servicio (Render pone https y el host).
function urlPublica(req) {
  return process.env.KIT_API_URL || `${req.protocol}://${req.get('host')}`;
}

const PUEDEN = new Set(['owner', 'admin', 'service']);
const { getPermisos, puedeSeccion } = require('../services/auth/permisos');

// Dueño y Administración vinculan PC y bajan el instalador. Un rol a medida, solo si tiene
// la sección Conexiones (para vincular/desvincular, en "Editar").
async function soloAdmin(req, res, next) {
  if (!PUEDEN.has(req.businessRole)) return res.status(403).json({ error: 'forbidden', need: 'admin' });
  if (req.businessRole === 'admin') {
    try {
      const permisos = await getPermisos(req.user?.id, req.businessId);
      const modo = req.method === 'GET' ? 'ver' : 'editar';
      if (!puedeSeccion(permisos, 'conexiones', modo)) return res.status(403).json({ error: 'sin_permiso', seccion: 'conexiones', modo });
    } catch (e) { return next(e); }
  }
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
    res.json({ version: v ? { version: v.version, publicado: v.publicado_en, tamano: v.tamano, archivos: v.archivos } : null });
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

module.exports = router;
