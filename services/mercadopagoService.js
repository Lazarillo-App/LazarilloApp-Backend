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
// Va por SUCURSAL (14/11, usuaria): cada sucursal conecta su propia cuenta. sucursal 0 = la
// principal, > 0 = app_branches.id. La sucursal viaja dentro del estado firmado.
//
// Datos: traerCobros() usa la búsqueda de pagos (/v1/payments/search) día por día y arma las
// filas con el mismo formato que el módulo de conciliación lee del archivo "Todas las
// transacciones" (parseBanco), así el módulo no cambia.
'use strict';

const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { encryptSecret, decryptSecret } = require('../utils/cryptoField');
const reportes = require('./mercadopagoReportes');

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
function firmarEstado(businessId, userId, sucursal = 0) {
  return jwt.sign({ b: Number(businessId), u: Number(userId) || 0, s: Number(sucursal) || 0, t: 'mp' }, env().secreto, { expiresIn: '20m' });
}
/** { error } si no vale; { sucursal } si es del mismo negocio y usuario. */
function verificarEstado(state, businessId, userId) {
  try {
    const p = jwt.verify(String(state || ''), env().secreto);
    if (p.t !== 'mp') return { error: 'estado_invalido' };
    if (Number(p.b) !== Number(businessId)) return { error: 'otro_negocio' };
    if (Number(p.u) !== (Number(userId) || 0)) return { error: 'otro_usuario' };
    return { sucursal: Number(p.s) || 0 };
  } catch {
    return { error: 'estado_vencido' };
  }
}

function urlAutorizacion(businessId, userId, sucursal = 0) {
  const e = env();
  const q = new URLSearchParams({
    client_id: e.clientId, response_type: 'code', platform_id: 'mp',
    state: firmarEstado(businessId, userId, sucursal), redirect_uri: e.redirect,
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
  const ve = verificarEstado(state, businessId, userId);
  if (ve.error) return { error: ve.error };
  const sucursal = ve.sucursal;
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
       (business_id, sucursal, mp_user_id, mp_nickname, mp_email, access_token, refresh_token, expira_at, live_mode, conectado_por, conectado_at, ultimo_sync_error, updated_at)
     VALUES ($1, $10, $2, $3, $4, $5, $6, $7, $8, $9, now(), NULL, now())
     ON CONFLICT (business_id, sucursal) DO UPDATE SET
       mp_user_id = EXCLUDED.mp_user_id, mp_nickname = EXCLUDED.mp_nickname, mp_email = EXCLUDED.mp_email,
       access_token = EXCLUDED.access_token, refresh_token = EXCLUDED.refresh_token, expira_at = EXCLUDED.expira_at,
       live_mode = EXCLUDED.live_mode, conectado_por = EXCLUDED.conectado_por, conectado_at = now(),
       ultimo_sync_error = NULL, updated_at = now()`,
    [businessId, tok.user_id || yo?.id || null, yo?.nickname || null, yo?.email || null,
      encryptSecret(tok.access_token), tok.refresh_token ? encryptSecret(tok.refresh_token) : null,
      venceEn(tok.expires_in), tok.live_mode ?? null, userId || null, sucursal]);
  return { ok: true, sucursal, cuenta: { user_id: tok.user_id || yo?.id || null, nickname: yo?.nickname || null, email: yo?.email || null } };
}

async function fila(businessId, sucursal = 0) {
  const { rows } = await pool.query(`SELECT *, ultimo_sync_desde::text AS sync_desde_txt, ultimo_sync_hasta::text AS sync_hasta_txt
       FROM integraciones_mercadopago WHERE business_id = $1 AND sucursal = $2`, [businessId, sucursal]);
  return rows[0] || null;
}

/** Lo que ve la pantalla (nunca los tokens). */
async function estado(businessId, sucursal = 0) {
  const f = await fila(businessId, sucursal);
  return {
    configurado: configurado(),
    conectado: !!f,
    cuenta: f ? { user_id: f.mp_user_id, nickname: f.mp_nickname, email: f.mp_email } : null,
    conectado_at: f?.conectado_at || null,
    expira_at: f?.expira_at || null,
    ultimo_sync_at: f?.ultimo_sync_at || null,
    // como texto YYYY-MM-DD (si no, el driver los manda como fecha con hora UTC)
    ultimo_sync_desde: f?.sync_desde_txt || null,
    ultimo_sync_hasta: f?.sync_hasta_txt || null,
    ultimo_sync_error: f?.ultimo_sync_error || null,
  };
}

async function desconectar(businessId, sucursal = 0) {
  await pool.query('DELETE FROM integraciones_mercadopago WHERE business_id = $1 AND sucursal = $2', [businessId, sucursal]);
  return { ok: true };
}

/** Access token válido (lo renueva si vence en menos de 7 días). */
async function tokenVigente(businessId, sucursal = 0) {
  const f = await fila(businessId, sucursal);
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
         expira_at = $4, updated_at = now() WHERE business_id = $1 AND sucursal = $5`,
      [businessId, encryptSecret(tok.access_token), tok.refresh_token ? encryptSecret(tok.refresh_token) : null, venceEn(tok.expires_in), sucursal]);
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

// Nombre de quien pagó (13/11): con la cuenta del que cobra, payer.first_name/last_name suele venir
// vacío; en transferencias el nombre viene en los datos bancarios del que manda la plata.
function nombrePagador(p) {
  const limpio = (x) => String(x || '').replace(/\s+/g, ' ').trim();
  const candidatos = [
    [p.payer?.first_name, p.payer?.last_name].filter(Boolean).join(' '),
    p.point_of_interaction?.transaction_data?.bank_info?.payer?.long_name,
    [p.additional_info?.payer?.first_name, p.additional_info?.payer?.last_name].filter(Boolean).join(' '),
    p.payer?.name,
    p.card?.cardholder?.name,
  ];
  for (const c of candidatos) { const v = limpio(c); if (v && !/^(null|undefined)$/i.test(v)) return v; }
  return '';
}

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
  const nombre = nombrePagador(p);
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

/** Pagos aprobados día por día (hora de Argentina), filtrados por quien cobra o quien paga. */
async function buscarPagos(token, filtro, desde, hasta, convertir, { fetchPagina } = {}) {
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
      Object.entries(filtro || {}).forEach(([k, v]) => { if (v) q.set(k, String(v)); });
      const r = await pagina(`${API}/v1/payments/search?${q.toString()}`);
      const res = Array.isArray(r?.results) ? r.results : [];
      res.forEach((p) => { const x = convertir(p); if (x) filas.push(x); });
      offset += res.length;
      const total = Number(r?.paging?.total) || 0;
      if (res.length < 100 || offset >= total || offset >= 10000) break;
    }
  }
  return filas;
}

/** Cobros aprobados de la cuenta entre dos fechas (YYYY-MM-DD, hora de Argentina). */
function traerCobros(token, mpUserId, desde, hasta, opciones) {
  return buscarPagos(token, { 'collector.id': mpUserId }, desde, hasta, pagoAFila, opciones);
}

/**
 * Un pago que HIZO la cuenta (a un proveedor, una compra, una transferencia) → egreso.
 * Lo que la cuenta se paga a sí misma no es un egreso.
 */
function pagoHechoAFila(p, mpUserId) {
  if (!p || p.status !== 'approved') return null;
  if (mpUserId && String(p.collector_id ?? p.collector?.id ?? '') === String(mpUserId)) return null;
  const imp = Math.round((Number(p.transaction_amount) || 0) * 100) / 100;
  if (imp <= 0) return null;
  const f = enAR(p.date_approved || p.date_created);
  if (!f) return null;
  const detalle = String(p.description || '').trim()
    || (p.operation_type === 'money_transfer' ? 'Transferencia enviada' : 'Pago con Mercado Pago');
  return {
    id: `mpp${p.id}`, mpId: p.id, origen: 'pago', fecha: f.fecha, hora: f.hora,
    tipo: p.operation_type === 'money_transfer' ? 'Transferencia' : 'Pago', detalle,
    medio: TIPO_MEDIO[p.payment_type_id] || String(p.payment_type_id || ''), imp,
  };
}

function traerPagosHechos(token, mpUserId, desde, hasta, opciones) {
  return buscarPagos(token, { 'payer.id': mpUserId }, desde, hasta, (p) => pagoHechoAFila(p, mpUserId), opciones);
}

async function leerFuente(businessId, sucursal, tipo) {
  const { rows } = await pool.query(
    'SELECT filas FROM conciliacion_fuentes WHERE business_id = $1 AND sucursal = $2 AND tipo = $3', [businessId, sucursal, tipo]);
  return rows[0]?.filas || [];
}

async function escribirFuente(businessId, sucursal, tipo, filas, archivo) {
  const fechas = filas.map((x) => x.fecha).filter(Boolean).sort();
  await pool.query(
    `INSERT INTO conciliacion_fuentes (business_id, sucursal, tipo, archivo, filas, cantidad, desde, hasta, origen, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, 'mercadopago', now())
     ON CONFLICT (business_id, sucursal, tipo) DO UPDATE SET archivo = EXCLUDED.archivo, filas = EXCLUDED.filas,
       cantidad = EXCLUDED.cantidad, desde = EXCLUDED.desde, hasta = EXCLUDED.hasta, origen = 'mercadopago', updated_at = now()`,
    [businessId, sucursal, tipo, archivo, JSON.stringify(filas), filas.length, fechas[0] || null, fechas[fechas.length - 1] || null]);
}

/** Egresos: reemplaza los de ese origen ('pago' | 'reporte') en el rango y deja el resto. */
async function guardarEgresos(businessId, sucursal, desde, hasta, origen, nuevas) {
  const viejas = (await leerFuente(businessId, sucursal, 'egresos'))
    .filter((x) => !(x.origen === origen && x.fecha >= desde && x.fecha <= hasta));
  const todas = [...viejas, ...nuevas].sort((a, b) => `${a.fecha} ${a.hora || ''}`.localeCompare(`${b.fecha} ${b.hora || ''}`));
  await escribirFuente(businessId, sucursal, 'egresos', todas, `Mercado Pago ${desde} a ${hasta}`);
  return todas.length;
}

/**
 * Reporte de liberaciones (14/11): nombres de quienes transfirieron y egresos (retiros,
 * impuestos, comisiones…). MP lo arma en unos minutos: la primera vez queda "pendiente" y el
 * front vuelve a preguntar.
 */
async function aplicarReporte(businessId, sucursal, desde, hasta, { tokenListo } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(desde || '') || !/^\d{4}-\d{2}-\d{2}$/.test(hasta || '') || desde > hasta) {
    return { error: 'fechas_invalidas' };
  }
  const t = tokenListo || await tokenVigente(businessId, sucursal);
  if (t.error) return t;
  try {
    const cfg = await reportes.asegurarConfig(t.token);
    if (cfg.error) return { reporte: 'error', motivo: cfg.error };
    const b = await reportes.buscarOPedir(t.token, desde, hasta);
    if (b.error) return { reporte: 'error', motivo: b.error };
    if (b.pendiente) return { reporte: 'pendiente' };
    const d = await reportes.bajar(t.token, b.archivo);
    if (d.error) return { reporte: 'error', motivo: d.error };
    const { nombres, egresos } = reportes.analizar(reportes.parsearCSV(d.csv));
    // Nombres en los cobros que vinieron sin nombre.
    let conNombre = 0;
    if (nombres.size) {
      const banco = await leerFuente(businessId, sucursal, 'banco');
      banco.forEach((x) => {
        const n = x.mpId != null ? nombres.get(String(x.mpId)) : null;
        if (n && !x.cliente) { x.cliente = n; conNombre += 1; }
      });
      if (conNombre) {
        await pool.query(
          "UPDATE conciliacion_fuentes SET filas = $3::jsonb, updated_at = now() WHERE business_id = $1 AND sucursal = $2 AND tipo = 'banco'",
          [businessId, sucursal, JSON.stringify(banco)]);
      }
    }
    await guardarEgresos(businessId, sucursal, desde, hasta, 'reporte', egresos);
    return { reporte: 'listo', nombres: conNombre, egresos: egresos.length };
  } catch (e) {
    return { reporte: 'error', motivo: 'mp_reporte_fallo', detalle: e.message };
  }
}

/**
 * Trae los cobros del período y los deja como fuente "banco" del módulo de conciliación:
 * reemplaza lo que había de esas fechas (venga de archivo o de MP) y deja el resto.
 */
async function sincronizarBanco(businessId, sucursal, desde, hasta) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(desde || '') || !/^\d{4}-\d{2}-\d{2}$/.test(hasta || '') || desde > hasta) {
    return { error: 'fechas_invalidas' };
  }
  if (diasEntre(desde, hasta).length > MAX_DIAS) return { error: 'periodo_muy_largo' };
  const t = await tokenVigente(businessId, sucursal);
  if (t.error) return t;
  let nuevas;
  try {
    nuevas = await traerCobros(t.token, t.fila.mp_user_id, desde, hasta);
  } catch (e) {
    await pool.query('UPDATE integraciones_mercadopago SET ultimo_sync_error = $2, updated_at = now() WHERE business_id = $1 AND sucursal = $3',
      [businessId, String(e.message || e).slice(0, 300), sucursal]);
    return { error: 'mp_fallo_consulta', detalle: e.message };
  }
  const { rows } = await pool.query(
    "SELECT filas FROM conciliacion_fuentes WHERE business_id = $1 AND sucursal = $2 AND tipo = 'banco'", [businessId, sucursal]);
  const viejas = (rows[0]?.filas || []).filter((x) => !(x.fecha >= desde && x.fecha <= hasta));
  const todas = [...viejas, ...nuevas].sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));
  todas.forEach((x, i) => { x.ord = i; });
  const fechas = todas.map((x) => x.fecha).filter(Boolean).sort();
  await pool.query(
    `INSERT INTO conciliacion_fuentes (business_id, sucursal, tipo, archivo, filas, cantidad, desde, hasta, origen, updated_at)
     VALUES ($1, $7, 'banco', $2, $3::jsonb, $4, $5, $6, 'mercadopago', now())
     ON CONFLICT (business_id, sucursal, tipo) DO UPDATE SET archivo = EXCLUDED.archivo, filas = EXCLUDED.filas,
       cantidad = EXCLUDED.cantidad, desde = EXCLUDED.desde, hasta = EXCLUDED.hasta, origen = 'mercadopago', updated_at = now()`,
    [businessId, `Mercado Pago ${desde} a ${hasta}`, JSON.stringify(todas), todas.length, fechas[0] || null, fechas[fechas.length - 1] || null, sucursal]);
  await pool.query(
    `UPDATE integraciones_mercadopago SET ultimo_sync_at = now(), ultimo_sync_desde = $2, ultimo_sync_hasta = $3,
       ultimo_sync_error = NULL, updated_at = now() WHERE business_id = $1 AND sucursal = $4`, [businessId, desde, hasta, sucursal]);

  // Egresos (14/11): lo que pagó la cuenta en esas fechas…
  let pagosHechos = null;
  try {
    const hechos = await traerPagosHechos(t.token, t.fila.mp_user_id, desde, hasta);
    await guardarEgresos(businessId, sucursal, desde, hasta, 'pago', hechos);
    pagosHechos = hechos.length;
  } catch (e) {
    console.warn('[mercadopago] pagos hechos:', e.message);
  }
  // …y el reporte con nombres, retiros, impuestos y comisiones (puede quedar pendiente).
  const rep = await aplicarReporte(businessId, sucursal, desde, hasta, { tokenListo: t });
  return { ok: true, cobros: nuevas.length, total: todas.length, desde, hasta, pagos_hechos: pagosHechos, ...rep };
}

module.exports = {
  configurado, urlAutorizacion, conectar, estado, desconectar, tokenVigente, sincronizarBanco, aplicarReporte,
  // para tests
  _firmarEstado: firmarEstado, _verificarEstado: verificarEstado, _pagoAFila: pagoAFila, _traerCobros: traerCobros, _enAR: enAR,
  _pagoHechoAFila: pagoHechoAFila, _traerPagosHechos: traerPagosHechos,
};
