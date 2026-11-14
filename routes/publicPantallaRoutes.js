// routes/publicPantallaRoutes.js — pantallas de TV (sin login; ver controllers/pantallasController.js)
// Monta en: app.use('/api/public/pantalla', publicPantallaRoutes)
'use strict';
const router = require('express').Router();
const ctrl = require('../controllers/pantallasController');

// Freno simple para el pedido de códigos (público): 30 por hora por IP. En memoria: alcanza para
// una instancia; si el back pasa a varias, moverlo a la base.
const pedidos = new Map();
function limitarCodigos(req, res, next) {
  const ahora = Date.now();
  const ip = req.ip || 'x';
  const lista = (pedidos.get(ip) || []).filter((t) => ahora - t < 3600e3);
  if (lista.length >= 30) return res.status(429).json({ ok: false, error: 'demasiados_pedidos' });
  lista.push(ahora);
  pedidos.set(ip, lista);
  if (pedidos.size > 5000) pedidos.clear();
  next();
}

router.post('/codigo', limitarCodigos, ctrl.pedirCodigo);
router.get('/', ctrl.estado);

module.exports = router;
