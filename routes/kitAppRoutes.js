// routes/kitAppRoutes.js
// ⚙ Configuración › Conexiones (Diego, 08/11/2026): las PC vinculadas del negocio y su
// "Desvincular". Solo dueño/admin.
//   GET  /api/businesses/:businessId/kit/pcs
//   POST /api/businesses/:businessId/kit/pcs/:pcId/desvincular
'use strict';

const express = require('express');
const router = express.Router({ mergeParams: true });
const { requireBusinessAccess } = require('../middleware/requireBusinessAccess');
const kit = require('../services/kit/kitPcs');

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

module.exports = router;
