// routes/kitRoutes.js
// API del kit vinculado (Diego, 07-08/11/2026): lo usa el instalador y la corrida diaria de cada
// PC con MaxiRest. Va montado ANTES del authRequired general: el instalador entra con usuario y
// contraseña, y la corrida con la llave de su PC (Authorization: Kit lzk_...).
//
//   POST /api/kit/locales   { email, password }  → locales donde sos dueño/admin (con "ocupado")
//   POST /api/kit/vincular  { email, password, businessId, branchId?, pc, huella?, maestros?, reemplazar? }
//                           → { llave, esquema, pdv, maestros, ... } (la llave se ve UNA sola vez)
//   GET  /api/kit/yo        (llave) → a qué local está vinculada esta PC
//   POST /api/kit/cargas    (llave) { tabla, tipo, columnas, filas, numerar?, detalle? }
//                           → reemplaza esa tabla de ese pdv (ver services/kit/cargas.js)
//   GET  /api/kit/motor     (llave) → versión publicada del kit + sha256 de cada archivo de _motor
//   GET  /api/kit/motor/archivo?ruta=gen/lz_render.py  (llave) → ese archivo (para actualizarse sin Drive)
'use strict';

const express = require('express');
const router = express.Router();
const kit = require('../services/kit/kitPcs');
const { cargar } = require('../services/kit/cargas');
const versiones = require('../services/kit/versiones');

// Freno simple a probar contraseñas: 8 intentos fallidos por IP+email cada 15 minutos.
const fallos = new Map();
const VENTANA_MS = 15 * 60_000;
const MAX_FALLOS = 8;
function claveIntento(req) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || '?';
  return `${ip}|${String(req.body?.email || '').trim().toLowerCase()}`;
}
function bloqueado(req) {
  const f = fallos.get(claveIntento(req));
  return f && f.n >= MAX_FALLOS && Date.now() - f.desde < VENTANA_MS;
}
function anotarFallo(req) {
  const k = claveIntento(req);
  const f = fallos.get(k);
  if (!f || Date.now() - f.desde >= VENTANA_MS) fallos.set(k, { n: 1, desde: Date.now() });
  else f.n++;
  if (fallos.size > 5000) fallos.clear();
}

async function conUsuario(req, res) {
  if (bloqueado(req)) { res.status(429).json({ error: 'demasiados_intentos' }); return null; }
  const u = await kit.verificarUsuario(req.body?.email, req.body?.password);
  if (!u) { anotarFallo(req); res.status(401).json({ error: 'usuario_o_contrasena_incorrectos' }); return null; }
  fallos.delete(claveIntento(req));
  return u;
}

router.post('/locales', async (req, res, next) => {
  try {
    const u = await conUsuario(req, res);
    if (!u) return;
    const locales = await kit.localesDe(u.id);
    res.set('Cache-Control', 'no-store');
    res.json({ usuario: u.display_name || u.name || u.email, locales });
  } catch (e) { next(e); }
});

router.post('/vincular', async (req, res, next) => {
  try {
    const u = await conUsuario(req, res);
    if (!u) return;
    const r = await kit.vincular(u, req.body || {});
    console.log(`[kit] PC ${req.body?.pc} vinculada a ${r.esquema}.${r.pdv} por usuario ${u.id}${r.reemplazo ? ` (reemplaza a ${r.reemplazo})` : ''}`);
    // Recetas (ventas/compras del kit) reconoce el negocio nuevo sin esperar el refresco de 10 min.
    require('../services/maxiPdvMap').refrescarPdvMap({ forzar: true }).catch(() => {});
    res.set('Cache-Control', 'no-store');
    res.status(201).json({ ok: true, ...r });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, ocupado: e.ocupado || undefined });
    next(e);
  }
});

// ---------------------------------------------------------------- con la llave de la PC
async function conLlave(req, res, next) {
  try {
    const m = /^Kit\s+(\S+)$/i.exec(req.headers.authorization || '');
    const pc = m ? await kit.pcPorLlave(m[1]) : null;
    if (!pc) return res.status(401).json({ error: 'pc_no_vinculada' });
    req.kitPc = pc;
    kit.tocar(pc.id, req.headers['x-lazarillo-motor']).catch(() => {});
    next();
  } catch (e) { next(e); }
}

router.get('/yo', conLlave, (req, res) => {
  const p = req.kitPc;
  res.json({ pcId: p.id, pc: p.pc_nombre, negocio: p.negocio, sucursal: p.sucursal || null,
    esquema: p.esquema, pdv: p.pdv, maestros: p.maestros, pos: p.pos });
});

router.post('/cargas', conLlave, async (req, res, next) => {
  try {
    const t0 = Date.now();
    const r = await cargar(req.kitPc, req.body);
    res.json({ ok: true, ...r, ms: Date.now() - t0 });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

router.get('/motor', conLlave, async (req, res, next) => {
  try {
    const m = await versiones.manifiesto();
    if (!m) return res.status(404).json({ error: 'todavia_no_hay_kit_publicado' });
    res.set('Cache-Control', 'no-store');
    res.json(m);
  } catch (e) { next(e); }
});

router.get('/motor/archivo', conLlave, async (req, res, next) => {
  try {
    const d = await versiones.archivo(req.query.ruta);
    if (!d) return res.status(404).json({ error: 'no_existe' });
    res.set('Cache-Control', 'no-store');
    res.set('Content-Type', 'application/octet-stream');
    res.send(d);
  } catch (e) { next(e); }
});

module.exports = router;
