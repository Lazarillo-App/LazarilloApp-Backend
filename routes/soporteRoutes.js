// routes/soporteRoutes.js — chat de Anthony y pedidos (usuarios logueados). Montado en /api/soporte.
'use strict';

const router = require('express').Router();
const soporte = require('../services/soporteService');
const ajustes = require('../services/ajustesService');

const negocioDe = (req) => Number(req.body?.businessId || req.query?.businessId || req.businessId || req.headers['x-business-id']) || null;

// Menú y respuestas de Anthony + WhatsApp (sin los mails ni los chats del equipo).
router.get('/chat', async (_req, res, next) => {
  try { res.json({ ok: true, ...(await soporte.chatPublico()) }); } catch (e) { next(e); }
});

// Pedido nuevo (con captura opcional) → se guarda, va por mail al equipo y avisa por Telegram.
router.post('/mensaje', async (req, res, next) => {
  try {
    const { opcion, respuesta, mensaje, contexto, captura, tipo, pantalla } = req.body || {};
    const r = await soporte.enviarMensaje({
      user: req.user, businessId: negocioDe(req), opcion, respuesta, mensaje, contexto, captura, tipo, pantalla,
    });
    if (r.error) return res.status(r.error === 'demasiados_mensajes' ? 429 : 400).json({ ok: false, error: r.error });
    res.json(r);
  } catch (e) { next(e); }
});

// Mis pedidos (con las respuestas del equipo) y cuántas respuestas nuevas hay.
router.get('/mis-pedidos', async (req, res, next) => {
  try { res.json({ ok: true, pedidos: await soporte.misPedidos(req.user.id) }); } catch (e) { next(e); }
});
router.get('/sin-leer', async (req, res, next) => {
  try { res.json({ ok: true, n: await soporte.sinLeer(req.user.id) }); } catch (e) { next(e); }
});
router.post('/mis-pedidos/vistos', async (req, res, next) => {
  try { await soporte.marcarVistos(req.user.id); res.json({ ok: true }); } catch (e) { next(e); }
});
router.post('/mis-pedidos/:id/responder', async (req, res, next) => {
  try {
    const r = await soporte.responderCliente(req.user.id, Number(req.params.id), req.body?.texto);
    if (r.error) return res.status(r.status || 400).json({ ok: false, error: r.error });
    res.json(r);
  } catch (e) { next(e); }
});

// Ajustes a medida que le tocan a este usuario en el negocio activo: { clave: valor }.
router.get('/ajustes', async (req, res, next) => {
  try { res.json({ ok: true, ajustes: await ajustes.efectivos(req.user.id, negocioDe(req)) }); } catch (e) { next(e); }
});

module.exports = router;
