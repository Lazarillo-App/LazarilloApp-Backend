// services/mercadopagoService.js
// Conexión de cada negocio con su cuenta de Mercado Pago (14/11/2026).
//
// Flujo (OAuth de Mercado Pago):
//   1. El negocio toca "Conectar" → urlAutorizacion() → va a auth.mercadopago.com y autoriza.
//   2. Mercado Pago vuelve a la app (MP_REDIRECT_URI, una pantalla del front) con ?code&state.
//   3. El front manda code+state → conectar() cambia el code por tokens y los guarda cifrados.
//   El access token dura 180 días; se renueva solo con el refresh token (tokenVigente()).
//
// Variables de entorno (Render): MP_CLIENT_ID, MP_CLIENT_SECRET (de la aplicación de Lazarillo en
// el panel de desarrolladores de Mercado Pago) y MP_REDIRECT_URI (opcional; por defecto
// FRONTEND_BASE_URL + FRONTEND_BASE_PATH + '/mercadopago/vuelta'; tiene que estar cargada igual en
// la aplicación de MP, en "URLs de redireccionamiento").
//
// Datos: traerCobros() usa la búsqueda de pagos (/v1/payments/search) día por día y arma las
// filas con el mismo formato que el módulo de conciliación lee del archivo "Todas las
// transacciones" (parseBanco), así el módulo no cambia.
'use strict';

const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { encryptSecret, decryptSecret } = require('../utils/cryptoField');

const API = 'https://api.mercadopago.com';
const AUTH = 'https://auth.mercadopago.com/authorization';
const TZ = 'America/Argentina/Buenos_Aires';
const MAX_DIAS = 92;

const env = () => ({
  clientId: String(process.env.MP_CLIENT_ID || '').trim(),
  clientSecret: String(process.env.MP_CLIENT_SECRET || '').trim(),
  redirect: String(process.env.MP_REDIRECT_URI || '').trim()
    || `${String(process.env.FRONTEND_BASE_URL || 'http://localhost:5173').replace(/\/+$/, '')}${String(process.env.FRONTEND_BASE_PATH || '').replace(/\/+$/, '')}/mercadopago/vuelta`,
  secreto: String(process.env.JWT_SECRET || process.env.ENCRYPTION_KEY || 'dev-mp-state'),
});

function configurado() {
  const e = env();
  return !!(e.clientId && e.clientSecret);
}

// ── estado firmado (que la vuelta sea del mismo negocio y usuario que empezó) ──
function firmarEstado(businessId, userId) {
  return jwt.sign({ b: Number(businessId), u: Number(userId) || 0, t: 'mp' }, env().secreto, { expiresIn: '20m' });
}
function verificarEstado(state, businessId, userId) {
  try {
    const p = jwt.verify(String(state || ''), env().secreto);
    if (p.t !== 'mp') return 'estado_invalido';
    if (Number(p.b) !== Number(businessId)) return 'otro_negocio';
    if (Number(p.u) !== (Number(userId) || 0)) return 'otro_usuario';
    return null;
  } catch {
    return 'estado_vencido';
  }
}

function urlAutorizacion(businessId, userId) {
  const e = env();
  const q = new URLSearchParams({
    client_id: e.clientId, response_type: 'code', platform_id: 'mp',
    state: firmarEstado(businessId, userId), redirect_uri: e.redirect,
  });
  return `${AUTH}?${q.toString()}`;
}

async function pedir(url, { method = 'GET', token, body, timeout = 30000 } = {}) {
  const r = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  });
  let data = null;
  try { data = await r.json(); } catch { data = null; }
  if (!r.ok) {
    const err = new Error((data && (data.message || data.error)) || `mercadopago_http_${r.status}`);
    err.status = r.status; err.data = data;
    throw err;
  }
  return data;
}

async function pedirTokens(body) {
  const e = env();
  return pedir(`${API}/oauth/token`, {
    method: 'POST', body: { client_id: e.clientId, client_secret: e.clientSecret, ...body },
  });
}

const venceEn = (seg) => (Number(seg) > 0 ? new Date(Date.now() + Number(seg) * 1000) : null);

/** Cambia el code de la vuelta por tokens y los guarda. */
async function conectar(businessId, userId, code, state) {
  if (!configurado()) return { error: 'mp_sin_configurar' };
  if (!code) return { error: 'falta_code' };
  const malEstado = verificarEstado(state, businessId, userId);
  if (malEstado) return { error: malEstado };
  let tok;
  try {
    tok = await pedirTokens({ grant_type: 'authorization_code', code: String(code), redirect_uri: env().redirect });
  } catch (e) {
    return { error: 'mp_rechazo_codigo', detalle: e.message };
  }
  if (!tok || !tok.access_token) return { error: 'mp_sin_token' };
  let yo = null;
  try { yo = await pedir(`${API}/users/me`, { token: tok.access_token }); } catch { yo = null; }
  await pool.query(
    `INSERT INTO integraciones_mercadopago
       (business_id, mp_user_id, mp_nickname, mp_email, access_token, refresh_token, expira_at, live_mode, conectado_por, conectado_at, ultimo_sync_error, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), NULL, now())
     ON CONFLICT (business_id) DO UPDATE SET
       mp_user_id = EXCLUDED.mp_user_id, mp_nickname = EXCLUDED.mp_nickname, mp_email = EXCLUDED.mp_email,
       access_token = EXCLUDED.access_token, refresh_token = EXCLUDED.refresh_token, expira_at = EXCLUDED.expira_at,
       live_mode = EXCLUDED.live_mode, conectado_por = EXCLUDED.conectado_por, conectado_at = now(),
       ultimo_sync_error = NULL, updated_at = now()`,
    [businessId, tok.user_id || yo?.id || null, yo?.nickname || null, yo?.email || null,
      encryptSecret(tok.access_token), tok.refresh_token ? encryptSecret(tok.refresh_token) : null,
      venceEn(tok.expires_in), tok.live_mode ?? null, userId || null]);
  return { ok: true, cuenta: { user_id: tok.user_id || yo?.id || null, nickname: yo?.nickname || null, email: yo?.email || null } };
}

async function fila(businessId) {
  const { rows } = await pool.query('SELECT * FROM integraciones_mercadopago WHERE business_id = $1', [businessId]);
  return rows[0] || null;
}

/** Lo que ve la pantalla (nunca los tokens). */
async function estado(businessId) {
  const f = await fila(businessId);
  return {
    configurado: configurado(),
    conectado: !!f,
    cuenta: f ? { user_id: f.mp_user_id, nickname: f.mp_nickname, email: f.mp_email } : null,
    conectado_at: f?.conectado_at || null,
    expira_at: f?.expira_at || null,
    ultimo_sync_at: f?.ultimo_sync_at || null,
    ultimo_sync_desde: f?.ultimo_sync_desde || null,
    ultimo_sync_hasta: f?.ultimo_sync_hasta || null,
    ultimo_sync_error: f?.ultimo_sync_error || null,
  };
}

async function desconectar(businessId) {
  await pool.query('DELETE FROM integraciones_mercadopago WHERE business_id = $1', [businessId]);
  return { ok: true };
}

/** Access token válido (lo renueva si vence en menos de 7 días). */
async function tokenVigente(businessId) {
  const f = await fila(businessId);
  if (!f) return { error: 'mp_no_conectado' };
  const access = decryptSecret(f.access_token);
  if (!access) return { error: 'mp_token_ilegible' };
  const vence = f.expira_at ? new Date(f.expira_at).getTime() : Infinity;
  if (vence - Date.now() > 7 * 86400000) return { token: access, fila: f };
  const refresh = f.refresh_token ? decryptSecret(f.refresh_token) : null;
  if (!refresh || !configurado()) return vence > Date.now() ? { token: access, fila: f } : { error: 'mp_vencido' };
  try {
    const tok = await pedirTokens({ grant_type: 'refresh_token', refresh_token: refresh });
    await pool.query(
      `UPDATE integraciones_mercadopago SET access_token = $2, refresh_token = COALESCE($3, refresh_token),
         expira_at = $4, updated_at = now() WHERE business_id = $1`,
      [businessId, encryptSecret(tok.access_token), tok.refresh_token ? encryptSecret(tok.refresh_token) : null, venceEn(tok.expires_in)]);
    return { token: tok.access_token, fila: f };
  } catch (e) {
    return vence > Date.now() ? { token: access, fila: f } : { error: 'mp_vencido', detalle: e.message };
  }
}

// ── fechas en hora de Argentina ──
const fmtAR = new Intl.DateTimeFormat('sv-SE', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});
function enAR(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const s = fmtAR.format(d).replace(' ', 'T'); // 2026-10-01T10:05:00
  return { fecha: s.slice(0, 10), hora: s.slice(11, 16), ts: s };
}

const TIPO_MEDIO = {
  account_money: 'Dinero en cuenta', credit_card: 'Tarjeta de crédito', debit_card: 'Tarjeta de débito',
  prepaid_card: 'Tarjeta prepaga', bank_transfer: 'Transferencia', ticket: 'Efectivo (cupón)', atm: 'Cajero',
  digital_currency: 'Moneda digital', digital_wallet: 'Billetera digital',
};

/**
 * Un pago de Mercado Pago → fila "banco" del módulo de conciliación (mismo formato que
 * parseBanco del archivo). Devuelve null si no es un ingreso aprobado.
 */
function pagoAFila(p) {
  if (!p || p.status !== 'approved') return null;
  const imp = Math.round(Number(p.transaction_amount) || 0);
  if (imp <= 0) return null;
  const f = enAR(p.date_approved || p.date_created);
  if (!f) return null;
  const nombre = [p.payer?.first_name, p.payer?.last_name].filter(Boolean).join(' ').trim();
  const desc = String(p.description || '');
  return {
    id: `mp${p.id}`, mpId: p.id, fecha: f.fecha, ts: f.ts, hora: f.hora, imp,
    medio: String(p.payment_method_id || ''),
    tipoMedio: TIPO_MEDIO[p.payment_type_id] || String(p.payment_type_id || ''),
    tipDesc: /tips|propina/i.test(desc),
    cliente: nombre,
    descripcion: desc,
    neto: p.transaction_details?.net_received_amount ?? null,
    status: 'pend', matchedWith: null,
  };
}

const diasEntre = (desde, hasta) => {
  const out = [];
  const d = new Date(`${desde}T12:00:00Z`), h = new Date(`${hasta}T12:00:00Z`);
  while (d <= h) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
};

/** Cobros aprobados de la cuenta entre dos fechas (YYYY-MM-DD, hora de Argentina). */
async function traerCobros(token, mpUserId, desde, hasta, { fetchPagina } = {}) {
  const pagina = fetchPagina || ((url) => pedir(url, { token }));
  const filas = [];
  for (const dia of diasEntre(desde, hasta)) {
    let offset = 0;
    for (;;) {
      const q = new URLSearchParams({
        sort: 'date_created', criteria: 'asc', range: 'date_created',
        begin_date: `${dia}T00:00:00.000-03:00`, end_date: `${dia}T23:59:59.999-03:00`,
        status: 'approved', limit: '100', offset: String(offset),
      });
      if (mpUserId) q.set('collector.id', String(mpUserId));
      const r = await pagina(`${API}/v1/payments/search?${q.toString()}`);
      const res = Array.isArray(r?.results) ? r.results : [];
      res.forEach((p) => { const x = pagoAFila(p); if (x) filas.push(x); });
      offset += res.length;
      const total = Number(r?.paging?.total) || 0;
      if (res.length < 100 || offset >= total || offset >= 10000) break;
    }
  }
  return filas;
}

/**
 * Trae los cobros del período y los deja como fuente "banco" del módulo de conciliación:
 * reemplaza lo que había de esas fechas (venga de archivo o de MP) y deja el resto.
 */
async function sincronizarBanco(businessId, desde, hasta) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(desde || '') || !/^\d{4}-\d{2}-\d{2}$/.test(hasta || '') || desde > hasta) {
    return { error: 'fechas_invalidas' };
  }
  if (diasEntre(desde, hasta).length > MAX_DIAS) return { error: 'periodo_muy_largo' };
  const t = await tokenVigente(businessId);
  if (t.error) return t;
  let nuevas;
  try {
    nuevas = await traerCobros(t.token, t.fila.mp_user_id, desde, hasta);
  } catch (e) {
    await pool.query('UPDATE integraciones_mercadopago SET ultimo_sync_error = $2, updated_at = now() WHERE business_id = $1',
      [businessId, String(e.message || e).slice(0, 300)]);
    return { error: 'mp_fallo_consulta', detalle: e.message };
  }
  const { rows } = await pool.query(
    "SELECT filas FROM conciliacion_fuentes WHERE business_id = $1 AND tipo = 'banco'", [businessId]);
  const viejas = (rows[0]?.filas || []).filter((x) => !(x.fecha >= desde && x.fecha <= hasta));
  const todas = [...viejas, ...nuevas].sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));
  todas.forEach((x, i) => { x.ord = i; });
  const fechas = todas.map((x) => x.fecha).filter(Boolean).sort();
  await pool.query(
    `INSERT INTO conciliacion_fuentes (business_id, tipo, archivo, filas, cantidad, desde, hasta, origen, updated_at)
     VALUES ($1, 'banco', $2, $3::jsonb, $4, $5, $6, 'mercadopago', now())
     ON CONFLICT (business_id, tipo) DO UPDATE SET archivo = EXCLUDED.archivo, filas = EXCLUDED.filas,
       cantidad = EXCLUDED.cantidad, desde = EXCLUDED.desde, hasta = EXCLUDED.hasta, origen = 'mercadopago', updated_at = now()`,
    [businessId, `Mercado Pago ${desde} a ${hasta}`, JSON.stringify(todas), todas.length, fechas[0] || null, fechas[fechas.length - 1] || null]);
  await pool.query(
    `UPDATE integraciones_mercadopago SET ultimo_sync_at = now(), ultimo_sync_desde = $2, ultimo_sync_hasta = $3,
       ultimo_sync_error = NULL, updated_at = now() WHERE business_id = $1`, [businessId, desde, hasta]);
  return { ok: true, cobros: nuevas.length, total: todas.length, desde, hasta };
}

module.exports = {
  configurado, urlAutorizacion, conectar, estado, desconectar, tokenVigente, sincronizarBanco,
  // para tests
  _firmarEstado: firmarEstado, _verificarEstado: verificarEstado, _pagoAFila: pagoAFila, _traerCobros: traerCobros, _enAR: enAR,
};
