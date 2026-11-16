// routes/claudeRoutes.js
//
// Lectura del tablero de tareas para Claude, sin iniciar sesión (usuaria 15/11/2026: que Claude vea
// los pendientes y los vaya tomando). En vez de compartir el usuario de nadie, Claude manda un token
// propio: CLAUDE_TOKEN en Render, y una copia en la compu de la usuaria FUERA de los repos.
//
// SOLO LECTURA: tareas abiertas y hechas recientes, el detalle con sus notas y la Guía del proyecto.
// Para escribir sigue el camino de claude/sync.json (services/claudeSync.js).
//
//   GET /api/claude/tareas        → { tareas, modulos }
//   GET /api/claude/tareas/:id    → la tarea con lista_notas
//   GET /api/claude/guia          → { guia }
//
// Header: Authorization: Bearer <CLAUDE_TOKEN>. Sin CLAUDE_TOKEN configurado (o con menos de 32
// caracteres) la ruta no existe (404), así un token vacío o corto nunca abre nada.
'use strict';

const crypto = require('crypto');
const express = require('express');
const tablero = require('../services/tableroService');

const MIN_LARGO = 32;

/** Compara el token del pedido con el configurado sin filtrar por tiempo cuánto coincide. */
function tokenValido(recibido, configurado) {
  if (!configurado || configurado.length < MIN_LARGO || !recibido) return false;
  const a = crypto.createHash('sha256').update(String(recibido)).digest();
  const b = crypto.createHash('sha256').update(String(configurado)).digest();
  return crypto.timingSafeEqual(a, b);
}

function requireClaudeToken(req, res, next) {
  const configurado = process.env.CLAUDE_TOKEN || '';
  if (configurado.length < MIN_LARGO) return res.status(404).json({ error: 'not_found' });
  const m = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
  if (!tokenValido(m?.[1]?.trim(), configurado)) return res.status(401).json({ error: 'token_invalido' });
  res.set('Cache-Control', 'no-store');
  return next();
}

const router = express.Router();
router.use(requireClaudeToken);

router.get('/tareas', async (_req, res, next) => {
  try {
    const { tareas, modulos } = await tablero.listar();
    res.json({ tareas, modulos });
  } catch (e) { next(e); }
});

router.get('/tareas/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'id_invalido' });
    const t = await tablero.detalle(id);
    return t ? res.json(t) : res.status(404).json({ error: 'no_encontrada' });
  } catch (e) { return next(e); }
});

router.get('/guia', async (_req, res, next) => {
  try { res.json(await tablero.leerGuia()); } catch (e) { next(e); }
});

module.exports = router;
module.exports._tokenValido = tokenValido;
module.exports._requireClaudeToken = requireClaudeToken;
