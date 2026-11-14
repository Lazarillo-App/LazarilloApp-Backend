// services/mercadolibreService.js
// Mercado Libre (usuaria 14/11/2026): las compras que hace el negocio en Mercado Libre llegan al
// Panel de Gestión para cargarlas como factura. Mismo esquema que Mercado Pago: el negocio
// autoriza a Lazarillo (OAuth), los tokens se guardan cifrados y "Traer compras" busca las
// órdenes donde el negocio es el comprador.
//
// Hace falta una aplicación de Lazarillo en https://developers.mercadolibre.com.ar y en Render:
//   ML_CLIENT_ID, ML_CLIENT_SECRET y (opcional) ML_REDIRECT_URI. La URL de redirección de la app
//   es FRONTEND_BASE_URL + FRONTEND_BASE_PATH + /mercadolibre/vuelta.
// Docs: https://developers.mercadolibre.com.ar/es_ar/autenticacion-y-autorizacion
'use strict';

const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { encryptSecret, decryptSecret } = require('../utils/cryptoField');

const API = 'https://api.mercadolibre.com';
const AUTH = 'https://auth.mercadolibre.com.ar/authorization';
const MAX_DIAS = 366;

const env = () => ({
  clientId: String(process.env.ML_CLIENT_ID || '').trim(),
  clientSecret: String(process.env.ML_CLIENT_SECRET || '').trim(),
  redirect: String(process.env.ML_REDIRECT_URI || '').trim()
    || `${String(process.env.FRONTEND_BASE_URL || 'http://localhost:5173').replace(/\/+$/, '')}${String(process.env.FRONTEND_BASE_PATH || '').replace(/\/+$/, '')}/mercadolibre/vuelta`,
  secreto: String(process.env.JWT_SECRET || process.env.ENCRYPTION_KEY || 'dev-ml-state'),
});

function configurado() {
  const e = env();
  return !!(e.clientId && e.clientSecret);
}

// ── estado firmado (que la vuelta sea del mismo negocio y usuario que empezó) ──
function firmarEstado(businessId, userId) {
  return jwt.sign({ b: Number(businessId), u: Number(userId) || 0, t: 'ml' }, env().secreto, { expiresIn: '20m' });
}
function verificarEstado(state, businessId, userId) {
  try {
    const p = jwt.verify(String(state || ''), env().secreto);
    if (p.t !== 'ml') return { error: 'estado_invalido' };
    if (Number(p.b) !== Number(businessId)) return { error: 'otro_negocio' };
    if (Number(p.u) !== (Number(userId) || 0)) return { error: 'otro_usuario' };
    return { ok: true };
  } catch {
    return { error: 'estado_vencido' };
  }
}

function urlAutorizacion(businessId, userId) {
  const e = env();
  const q = new URLSearchParams({ response_type: 'code', client_id: e.clientId, redirect_uri: e.redirect, state: firmarEstado(businessId, userId) });
  return `${AUTH}?${q.toString()}`;
}

async function pedir(url, { method = 'GET', token, form, timeout = 30000 } = {}) {
  const r = await fetch(url, {
    method,
    headers: {
      Accept: 'application/json',
      ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: form ? new URLSearchParams(form).toString() : undefined,
    signal: AbortSignal.timeout(timeout),
  });
  let data = null;
  try { data = await r.json(); } catch { data = null; }
  if (!r.ok) {
    const err = new Error((data && (data.message || data.error)) || `mercadolibre_http_${r.status}`);
    err.status = r.status; err.data = data;
    throw err;
  }
  return data;
}

const pedirTokens = (form) => {
  const e = env();
  return pedir(`${API}/oauth/token`, { method: 'POST', form: { client_id: e.clientId, client_secret: e.clientSecret, ...form } });
};
const venceEn = (seg) => (Number(seg) > 0 ? new Date(Date.now() + Number(seg) * 1000) : null);

async function conectar(businessId, userId, code, state) {
  if (!configurado()) return { error: 'ml_sin_configurar' };
  if (!code) return { error: 'falta_code' };
  const ve = verificarEstado(state, businessId, userId);
  if (ve.error) return { error: ve.error };
  let tok;
  try {
    tok = await pedirTokens({ grant_type: 'authorization_code', code: String(code), redirect_uri: env().redirect });
  } catch (e) {
    return { error: 'ml_rechazo_codigo', detalle: e.message };
  }
  if (!tok?.access_token) return { error: 'ml_sin_token' };
  let yo = null;
  try { yo = await pedir(`${API}/users/me`, { token: tok.access_token }); } catch { yo = null; }
  await pool.query(
    `INSERT INTO integraciones_mercadolibre (business_id, ml_user_id, ml_nickname, ml_email, access_token, refresh_token, expira_at, conectado_por, conectado_at, ultimo_sync_error, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), NULL, now())
     ON CONFLICT (business_id) DO UPDATE SET ml_user_id = EXCLUDED.ml_user_id, ml_nickname = EXCLUDED.ml_nickname, ml_email = EXCLUDED.ml_email,
       access_token = EXCLUDED.access_token, refresh_token = EXCLUDED.refresh_token, expira_at = EXCLUDED.expira_at,
       conectado_por = EXCLUDED.conectado_por, conectado_at = now(), ultimo_sync_error = NULL, updated_at = now()`,
    [businessId, tok.user_id || yo?.id || null, yo?.nickname || null, yo?.email || null, encryptSecret(tok.access_token),
      tok.refresh_token ? encryptSecret(tok.refresh_token) : null, venceEn(tok.expires_in), userId || null]);
  return { ok: true, cuenta: { user_id: tok.user_id || yo?.id || null, nickname: yo?.nickname || null } };
}

async function fila(businessId) {
  const { rows } = await pool.query('SELECT * FROM integraciones_mercadolibre WHERE business_id = $1', [businessId]);
  return rows[0] || null;
}

async function estado(businessId) {
  const f = await fila(businessId);
  let pendientes = 0;
  if (f) {
    const { rows } = await pool.query("SELECT COUNT(*)::int n FROM ml_compras WHERE business_id = $1 AND estado_carga = 'pendiente' AND estado_orden <> 'cancelled'", [businessId]);
    pendientes = rows[0].n;
  }
  return {
    configurado: configurado(),
    conectado: !!f,
    cuenta: f ? { user_id: f.ml_user_id, nickname: f.ml_nickname, email: f.ml_email } : null,
    conectado_at: f?.conectado_at || null,
    ultimo_sync_at: f?.ultimo_sync_at || null,
    ultimo_sync_error: f?.ultimo_sync_error || null,
    pendientes,
  };
}

async function desconectar(businessId) {
  await pool.query('DELETE FROM integraciones_mercadolibre WHERE business_id = $1', [businessId]);
  return { ok: true };
}

/** Token válido: el de Mercado Libre dura 6 horas; se renueva si le quedan menos de 10 minutos. */
async function tokenVigente(businessId) {
  const f = await fila(businessId);
  if (!f) return { error: 'ml_no_conectado' };
  const access = decryptSecret(f.access_token);
  if (!access) return { error: 'ml_token_ilegible' };
  const vence = f.expira_at ? new Date(f.expira_at).getTime() : Infinity;
  if (vence - Date.now() > 10 * 60000) return { token: access, fila: f };
  const refresh = f.refresh_token ? decryptSecret(f.refresh_token) : null;
  if (!refresh || !configurado()) return { error: 'ml_vencido' };
  try {
    const tok = await pedirTokens({ grant_type: 'refresh_token', refresh_token: refresh });
    // El refresh token de Mercado Libre se usa una vez: hay que guardar el nuevo.
    await pool.query(
      `UPDATE integraciones_mercadolibre SET access_token = $2, refresh_token = COALESCE($3, refresh_token), expira_at = $4, updated_at = now()
        WHERE business_id = $1`,
      [businessId, encryptSecret(tok.access_token), tok.refresh_token ? encryptSecret(tok.refresh_token) : null, venceEn(tok.expires_in)]);
    return { token: tok.access_token, fila: f };
  } catch (e) {
    return { error: 'ml_vencido', detalle: e.message };
  }
}

/** Una orden de Mercado Libre (el negocio compró) → fila de ml_compras. */
function ordenACompra(o) {
  if (!o || !o.id) return null;
  const items = (o.order_items || []).map((it) => ({
    titulo: String(it.item?.title || '').trim(),
    cantidad: Number(it.quantity) || 0,
    precio: Number(it.unit_price) || 0,
  }));
  return {
    order_id: Number(o.id),
    fecha: o.date_closed || o.date_created,
    total: Math.round((Number(o.paid_amount ?? o.total_amount) || 0) * 100) / 100,
    moneda: o.currency_id || 'ARS',
    estado_orden: String(o.status || ''),
    vendedor_id: o.seller?.id ? Number(o.seller.id) : null,
    vendedor: String(o.seller?.nickname || o.seller?.first_name || '').trim() || null,
    items,
  };
}

/** Órdenes donde el negocio es comprador, entre dos fechas (YYYY-MM-DD, hora de Argentina). */
async function traerOrdenes(token, mlUserId, desde, hasta, { fetchPagina } = {}) {
  const pagina = fetchPagina || ((url) => pedir(url, { token }));
  const out = [];
  let offset = 0;
  for (;;) {
    const q = new URLSearchParams({
      buyer: String(mlUserId),
      'order.date_created.from': `${desde}T00:00:00.000-03:00`,
      'order.date_created.to': `${hasta}T23:59:59.999-03:00`,
      sort: 'date_desc', limit: '50', offset: String(offset),
    });
    const r = await pagina(`${API}/orders/search?${q.toString()}`);
    const res = Array.isArray(r?.results) ? r.results : [];
    res.forEach((o) => { const c = ordenACompra(o); if (c) out.push(c); });
    offset += res.length;
    const total = Number(r?.paging?.total) || 0;
    if (res.length < 50 || offset >= total || offset >= 5000) break;
  }
  return out;
}

async function sincronizar(businessId, desde, hasta) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(desde || '') || !/^\d{4}-\d{2}-\d{2}$/.test(hasta || '') || desde > hasta) return { error: 'fechas_invalidas' };
  const dias = (Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / 86400000;
  if (dias > MAX_DIAS) return { error: 'periodo_muy_largo' };
  const t = await tokenVigente(businessId);
  if (t.error) return t;
  let compras;
  try {
    compras = await traerOrdenes(t.token, t.fila.ml_user_id, desde, hasta);
  } catch (e) {
    await pool.query('UPDATE integraciones_mercadolibre SET ultimo_sync_error = $2, updated_at = now() WHERE business_id = $1',
      [businessId, String(e.message || e).slice(0, 300)]);
    return { error: 'ml_fallo_consulta', detalle: e.message };
  }
  for (const c of compras) {
    // Lo que el usuario ya marcó (cargada / descartada) no se pisa.
    await pool.query(
      `INSERT INTO ml_compras (business_id, order_id, fecha, total, moneda, estado_orden, vendedor_id, vendedor, items, traida_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, now())
       ON CONFLICT (business_id, order_id) DO UPDATE SET fecha = EXCLUDED.fecha, total = EXCLUDED.total, moneda = EXCLUDED.moneda,
         estado_orden = EXCLUDED.estado_orden, vendedor_id = EXCLUDED.vendedor_id, vendedor = EXCLUDED.vendedor, items = EXCLUDED.items, traida_at = now()`,
      [businessId, c.order_id, c.fecha, c.total, c.moneda, c.estado_orden, c.vendedor_id, c.vendedor, JSON.stringify(c.items)]);
  }
  await pool.query('UPDATE integraciones_mercadolibre SET ultimo_sync_at = now(), ultimo_sync_error = NULL, updated_at = now() WHERE business_id = $1', [businessId]);
  return { ok: true, compras: compras.length, desde, hasta };
}

/** Compras para el Panel: las pendientes (sin las canceladas) y, aparte, las ya marcadas. */
async function listar(businessId) {
  const { rows } = await pool.query(
    `SELECT order_id::text AS order_id, fecha, total::float AS total, moneda, estado_orden, vendedor, items, estado_carga, marcada_at
       FROM ml_compras WHERE business_id = $1 AND estado_orden <> 'cancelled'
      ORDER BY (estado_carga = 'pendiente') DESC, fecha DESC LIMIT 500`, [businessId]);
  return { compras: rows };
}

async function marcar(businessId, orderId, estadoCarga, userId) {
  if (!['pendiente', 'cargada', 'descartada'].includes(estadoCarga)) return { error: 'estado_invalido' };
  const { rowCount } = await pool.query(
    `UPDATE ml_compras SET estado_carga = $3, marcada_por = $4, marcada_at = CASE WHEN $3 = 'pendiente' THEN NULL ELSE now() END
      WHERE business_id = $1 AND order_id = $2`, [businessId, String(orderId), estadoCarga, userId || null]);
  return rowCount ? { ok: true } : { error: 'no_encontrada' };
}

module.exports = {
  configurado, urlAutorizacion, conectar, estado, desconectar, tokenVigente, sincronizar, listar, marcar,
  // para tests
  _firmarEstado: firmarEstado, _verificarEstado: verificarEstado, _ordenACompra: ordenACompra, _traerOrdenes: traerOrdenes,
};
