// controllers/pantallasController.js
//
// Pantallas de TV de las plazas de despacho (Diego 14/11/2026). La TV de la cocina solo MUESTRA el tablero;
// se edita desde la PC. Flujo, igual que vincular Netflix:
//   1. La TV abre /pantalla → POST /api/public/pantalla/codigo → recibe un token (lo guarda) y un código
//      de 6 dígitos que muestra en grande.
//   2. Desde la PC, en el tablero: «Vincular TV» → POST /api/businesses/:b/plazas/:id/pantallas { codigo }.
//   3. La TV pregunta GET /api/public/pantalla (con su token): pendiente → sigue mostrando el código;
//      vinculada → recibe la plaza armada (la misma vista que el tablero). Si no cambió nada, 304.
//   4. «Desvincular» la borra y la TV vuelve a pedir un código.
// El token solo da acceso a ESA plaza y solo para ver; no vence. En la base se guarda su sha256.
'use strict';

const crypto = require('crypto');
const pool = require('../config/db');
const { armarVista, cargarPlaza, puedeArmar } = require('./plazasController');
const { avisarAbm } = require('../services/notificationService');

const VIGENCIA_MIN = 15;
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const tokenDe = (req) => String(req.get('x-pantalla-token') || '').trim();

/* ── Públicos (sin login): los usa la TV ───────────────────────────────────────────── */

/** POST /api/public/pantalla/codigo → { token, codigo, venceEnSeg } */
exports.pedirCodigo = async (req, res, next) => {
  try {
    // Limpieza: códigos que nadie usó en el último día.
    await pool.query(`DELETE FROM pantallas WHERE plaza_id IS NULL AND codigo_vence < NOW() - INTERVAL '1 day'`);
    const token = crypto.randomBytes(32).toString('base64url');
    for (let i = 0; i < 8; i++) {
      const codigo = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
      const { rows } = await pool.query(
        `INSERT INTO pantallas (token_hash, codigo, codigo_vence)
         SELECT $1, $2, NOW() + ($3::int * INTERVAL '1 minute')
          WHERE NOT EXISTS (SELECT 1 FROM pantallas WHERE codigo = $2 AND plaza_id IS NULL AND deleted_at IS NULL AND codigo_vence > NOW())
         RETURNING id`, [sha(token), codigo, VIGENCIA_MIN]);
      if (rows.length) return res.status(201).json({ ok: true, token, codigo, venceEnSeg: VIGENCIA_MIN * 60 });
    }
    res.status(503).json({ ok: false, error: 'sin_codigo' });
  } catch (e) { next(e); }
};

/** GET /api/public/pantalla  (header X-Pantalla-Token)
 *  → { estado: 'pendiente', codigo, venceEnSeg } | { estado: 'vencido' } | { estado: 'desvinculada' }
 *  | { estado: 'sin_plaza' } | { estado: 'vinculada', plaza, productos } */
exports.estado = async (req, res, next) => {
  try {
    const t = tokenDe(req);
    if (!t) return res.status(401).json({ ok: false, estado: 'desvinculada' });
    const { rows } = await pool.query(
      `SELECT id, codigo, codigo_vence, business_id, plaza_id, EXTRACT(EPOCH FROM (codigo_vence - NOW()))::int AS resta
         FROM pantallas WHERE token_hash = $1 AND deleted_at IS NULL`, [sha(t)]);
    const p = rows[0];
    // Sin no-store: con el ETag de Express, si la plaza no cambió la TV recibe un 304 sin cuerpo.
    res.set('Cache-Control', 'no-cache');
    if (!p) return res.json({ ok: true, estado: 'desvinculada' });
    if (!p.plaza_id) {
      if (!(p.resta > 0)) return res.json({ ok: true, estado: 'vencido' });
      return res.json({ ok: true, estado: 'pendiente', codigo: p.codigo, venceEnSeg: p.resta });
    }
    pool.query('UPDATE pantallas SET ultima_vez = NOW() WHERE id = $1', [p.id]).catch(() => {});
    const plaza = await cargarPlaza(p.plaza_id, p.business_id);
    if (!plaza) return res.json({ ok: true, estado: 'sin_plaza' });
    const v = await armarVista(plaza, p.business_id);
    res.json({ ok: true, estado: 'vinculada', ...v });
  } catch (e) { next(e); }
};

/* ── Con login: se gestionan desde el tablero (dueño/admin o el jefe del sector) ───────── */

async function plazaGestionable(req, res) {
  const bizId = num(req.businessId);
  const plaza = await cargarPlaza(num(req.params.id), bizId);
  if (!plaza) { res.status(404).json({ ok: false, error: 'not_found' }); return null; }
  if (!(await puedeArmar(req, plaza))) { res.status(403).json({ ok: false, error: 'forbidden' }); return null; }
  return { bizId, plaza };
}

/** GET /api/businesses/:b/plazas/:id/pantallas → TVs vinculadas a la plaza */
exports.listar = async (req, res, next) => {
  try {
    const g = await plazaGestionable(req, res);
    if (!g) return;
    const { rows } = await pool.query(
      `SELECT id, nombre, vinculada_at, ultima_vez FROM pantallas
        WHERE business_id = $1 AND plaza_id = $2 AND deleted_at IS NULL ORDER BY vinculada_at`, [g.bizId, g.plaza.id]);
    res.json({ ok: true, pantallas: rows });
  } catch (e) { next(e); }
};

/** POST /api/businesses/:b/plazas/:id/pantallas { codigo, nombre? } */
exports.vincular = async (req, res, next) => {
  try {
    const g = await plazaGestionable(req, res);
    if (!g) return;
    const codigo = String(req.body?.codigo || '').replace(/\D/g, '');
    if (codigo.length !== 6) return res.status(400).json({ ok: false, error: 'codigo_invalido' });
    const nombre = String(req.body?.nombre || '').trim().slice(0, 40) || 'TV';
    const { rows } = await pool.query(
      `UPDATE pantallas SET business_id = $2, plaza_id = $3, nombre = $4, vinculada_por = $5, vinculada_at = NOW(),
              codigo = NULL, codigo_vence = NULL
        WHERE codigo = $1 AND plaza_id IS NULL AND deleted_at IS NULL AND codigo_vence > NOW()
        RETURNING id, nombre, vinculada_at, ultima_vez`,
      [codigo, g.bizId, g.plaza.id, nombre, num(req.user?.id)]);
    if (!rows.length) return res.status(404).json({ ok: false, error: 'codigo_invalido', message: 'Ese código no existe o ya venció. Fijate el que muestra la TV.' });
    avisarAbm(req, { businessId: g.bizId, type: 'pantalla_vincular', title: `TV vinculada: ${g.plaza.nombre}`,
      message: rows[0].nombre, metadata: { scope: 'plaza', ids: [g.plaza.id] } });
    res.status(201).json({ ok: true, pantalla: rows[0] });
  } catch (e) { next(e); }
};

/** DELETE /api/businesses/:b/plazas/:id/pantallas/:pid */
exports.desvincular = async (req, res, next) => {
  try {
    const g = await plazaGestionable(req, res);
    if (!g) return;
    const { rows } = await pool.query(
      `UPDATE pantallas SET deleted_at = NOW()
        WHERE id = $1 AND business_id = $2 AND plaza_id = $3 AND deleted_at IS NULL RETURNING nombre`,
      [num(req.params.pid), g.bizId, g.plaza.id]);
    if (!rows.length) return res.status(404).json({ ok: false, error: 'not_found' });
    avisarAbm(req, { businessId: g.bizId, type: 'pantalla_desvincular', title: `TV desvinculada: ${g.plaza.nombre}`,
      message: rows[0].nombre, metadata: { scope: 'plaza', ids: [g.plaza.id] } });
    res.json({ ok: true });
  } catch (e) { next(e); }
};
