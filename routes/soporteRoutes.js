// routes/soporteRoutes.js — chat de Anthony (usuarios logueados). Montado en /api/soporte.
'use strict';

const router = require('express').Router();
const soporte = require('../services/soporteService');

// Menú y respuestas de Anthony + WhatsApp (sin los mails del equipo).
router.get('/chat', async (_req, res, next) => {
  try { res.json({ ok: true, ...(await soporte.chatPublico()) }); } catch (e) { next(e); }
});

// Mensaje final del chat → se guarda y llega por mail al equipo.
router.post('/mensaje', async (req, res, next) => {
  try {
    const { opcion, respuesta, mensaje, contexto } = req.body || {};
    const businessId = Number(req.body?.businessId || req.businessId || req.headers['x-business-id']) || null;
    const r = await soporte.enviarMensaje({ user: req.user, businessId, opcion, respuesta, mensaje, contexto });
    if (r.error) return res.status(r.error === 'demasiados_mensajes' ? 429 : 400).json({ ok: false, error: r.error });
    res.json(r);
  } catch (e) { next(e); }
});

module.exports = router;
