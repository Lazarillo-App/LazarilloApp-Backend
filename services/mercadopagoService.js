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
  // Varias cuentas por sucursal (Diego 15/11/2026): la clave es negocio + sucursal + cuenta. Volver a
  // conectar la MISMA cuenta la actualiza; otra cuenta se suma al lado, sin pisar a la primera.
  if (!(tok.user_id || yo?.id)) return { error: 'mp_sin_cuenta' };
  await pool.query(
    `INSERT INTO integraciones_mercadopago
       (business_id, sucursal, mp_user_id, mp_nickname, mp_email, access_token, refresh_token, expira_at, live_mode, conectado_por, conectado_at, ultimo_sync_error, updated_at)
     VALUES ($1, $10, $2, $3, $4, $5, $6, $7, $8, $9, now(), NULL, now())
     ON CONFLICT (business_id, sucursal, mp_user_id) DO UPDATE SET
       mp_user_id = EXCLUDED.mp_user_id, mp_nickname = EXCLUDED.mp_nickname, mp_email = EXCLUDED.mp_email,
       access_token = EXCLUDED.access_token, refresh_token = EXCLUDED.refresh_token, expira_at = EXCLUDED.expira_at,
       live_mode = EXCLUDED.live_mode, conectado_por = EXCLUDED.conectado_por, conectado_at = now(),
       ultimo_sync_error = NULL, updated_at = now()`,
    [businessId, tok.user_id || yo?.id || null, yo?.nickname || null, yo?.email || null,
      encryptSecret(tok.access_token), tok.refresh_token ? encryptSecret(tok.refresh_token) : null,
      venceEn(tok.expires_in), tok.live_mode ?? null, userId || null, sucursal]);
  return { ok: true, sucursal, cuenta: { user_id: tok.user_id || yo?.id || null, nickname: yo?.nickname || null, email: yo?.email || null } };
}

/** Las cuentas de MP de una sucursal, la primera conectada primero. */
async function filas(businessId, sucursal = 0) {
  const { rows } = await pool.query(`SELECT *, ultimo_sync_desde::text AS sync_desde_txt, ultimo_sync_hasta::text AS sync_hasta_txt
       FROM integraciones_mercadopago WHERE business_id = $1 AND sucursal = $2 ORDER BY conectado_at NULLS LAST, mp_user_id`,
  [businessId, sucursal]);
  return rows;
}

/** Una cuenta: la pedida, o la primera de la sucursal. */
async function fila(businessId, sucursal = 0, cuenta = null) {
  const lista = await filas(businessId, sucursal);
  return cuenta == null ? (lista[0] || null) : (lista.find((f) => String(f.mp_user_id) === String(cuenta)) || null);
}

/** Lo que ve la pantalla (nunca los tokens). */
async function estado(businessId, sucursal = 0) {
  const lista = await filas(businessId, sucursal);
  const f = lista[0] || null;
  return {
    // Todas las cuentas de la sucursal; los campos de abajo (cuenta, ultimo_sync_…) son de la primera.
    cuentas: lista.map((x) => ({
      user_id: x.mp_user_id, nickname: x.mp_nickname, email: x.mp_email, conectado_at: x.conectado_at,
      ultimo_sync_at: x.ultimo_sync_at || null, ultimo_sync_error: x.ultimo_sync_error || null,
      historial_completo: !!x.historial_completo,
    })),
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

/** Desconecta una cuenta. Con varias en la sucursal hay que decir cuál (nunca se borran todas de una). */
async function desconectar(businessId, sucursal = 0, cuenta = null) {
  const lista = await filas(businessId, sucursal);
  if (!lista.length) return { error: 'mp_no_conectado' };
  if (cuenta == null && lista.length > 1) return { error: 'elegi_cuenta' };
  const id = cuenta ?? lista[0].mp_user_id;
  await pool.query('DELETE FROM integraciones_mercadopago WHERE business_id = $1 AND sucursal = $2 AND mp_user_id = $3',
    [businessId, sucursal, id]);
  return { ok: true };
}

/** Access token válido (lo renueva si vence en menos de 7 días). */
async function tokenVigente(businessId, sucursal = 0, cuenta = null) {
  const f = await fila(businessId, sucursal, cuenta);
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
         expira_at = $4, updated_at = now() WHERE business_id = $1 AND sucursal = $5 AND mp_user_id = $6`,
      [businessId, encryptSecret(tok.access_token), tok.refresh_token ? encryptSecret(tok.refresh_token) : null, venceEn(tok.expires_in), sucursal, f.mp_user_id]);
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
    ...extrasDePago(p),
    status: 'pend', matchedWith: null,
  };
}

// Columnas extra de cada cobro (Diego 14/11/2026): cuándo se acredita, qué descontó MP separado
// (comisión / costo de cuotas / retenciones), referencia externa (el código que se carga en el POS),
// documento del pagador, caja/QR, cuotas y tarjeta. Lo que MP no manda queda vacío.
const redondo = (n) => Math.round((Number(n) || 0) * 100) / 100;
function descuentosDe(p) {
  const bruto = Number(p.transaction_amount) || 0;
  const netoMp = p.transaction_details?.net_received_amount;
  let comisionMp = 0, costoCuotas = 0, otros = 0;
  (Array.isArray(p.fee_details) ? p.fee_details : []).forEach((f) => {
    if (f?.fee_payer && f.fee_payer !== 'collector') return; // lo pagó el cliente, no se descuenta
    const a = Math.abs(Number(f?.amount) || 0);
    if (f?.type === 'financing_fee') costoCuotas += a;
    else if (f?.type === 'mercadopago_fee' || f?.type === 'application_fee') comisionMp += a;
    else otros += a;
  });
  // Lo que falta entre bruto y neto y no es comisión: retenciones (IIBB, IVA, Ganancias…).
  const retenciones = netoMp == null ? null
    : Math.max(0, redondo(bruto - Number(netoMp) - comisionMp - costoCuotas - otros));
  return { comisionMp: redondo(comisionMp + otros), costoCuotas: redondo(costoCuotas), retenciones };
}
function extrasDePago(p) {
  const acr = p.money_release_date ? enAR(p.money_release_date) : null;
  const ident = p.payer?.identification || p.point_of_interaction?.transaction_data?.bank_info?.payer?.identification || {};
  const doc = String(ident.number || '').replace(/\s+/g, '').trim();
  const cuotas = Number(p.installments) || 0;
  const op = String(p.id ?? '');
  return {
    op: op || null,
    // Cómo queda el número de operación en el cupón de MaxiRest (informe 22): MaxiRest guarda 10
    // dígitos — los primeros 9 y el último (verificado con Container Bar, oct–nov 2026: 1.256 de 1.272).
    claveMx: op.length > 10 ? `${op.slice(0, 9)}${op.slice(-1)}` : op || null,
    acredita: acr?.fecha || null,
    liberado: p.money_release_status ? p.money_release_status === 'released' : null,
    ...descuentosDe(p),
    ref: String(p.external_reference || '').trim() || null,
    docTipo: doc ? String(ident.type || '').trim() || null : null,
    doc: doc || null,
    caja: String(p.pos_id || '').trim() || null,
    local: String(p.store_id || '').trim() || null,
    cuotas: cuotas > 1 ? cuotas : null,
    tarjeta: p.card?.last_four_digits ? String(p.card.last_four_digits) : null,
    operacion: p.operation_type || null,
  };
}

/**
 * Devoluciones, contracargos y disputas (Diego 14/11/2026: «una pestaña más tipo ingresos,
 * salidas, devoluciones»). Sale del mismo pago: si MP lo devolvió (todo o parte), si el cliente
 * lo desconoció con la tarjeta o si está en disputa. Una fila por pago; si cambia de estado
 * (disputa → contracargo) se actualiza la misma fila.
 */
const TIPO_DEVOLUCION = { refunded: 'Devolución', charged_back: 'Contracargo', in_mediation: 'En disputa' };
function devolucionAFila(p) {
  if (!p) return null;
  const parcial = p.status === 'approved' && Number(p.transaction_amount_refunded) > 0;
  const tipo = parcial ? 'Devolución' : TIPO_DEVOLUCION[p.status];
  if (!tipo) return null;
  const bruto = Number(p.transaction_amount) || 0;
  const devuelto = p.status === 'in_mediation' ? bruto : (Number(p.transaction_amount_refunded) || (p.status === 'charged_back' || p.status === 'refunded' ? bruto : 0));
  if (devuelto <= 0) return null;
  const refunds = Array.isArray(p.refunds) ? p.refunds : [];
  const ultima = refunds.map((r) => r?.date_created).filter(Boolean).sort().pop();
  const f = enAR(ultima || p.date_last_updated || p.date_created);
  const c = enAR(p.date_approved || p.date_created);
  if (!f) return null;
  return {
    id: `mpd${p.id}`, mpId: p.id, fecha: f.fecha, hora: f.hora, tipo,
    parcial: parcial || (devuelto < bruto && tipo === 'Devolución'),
    imp: redondo(devuelto), cobro: redondo(bruto), cobroFecha: c?.fecha || null,
    cliente: nombrePagador(p), medio: TIPO_MEDIO[p.payment_type_id] || String(p.payment_type_id || ''),
    ref: String(p.external_reference || '').trim() || null, detalle: String(p.description || ''),
  };
}

const diasEntre = (desde, hasta) => {
  const out = [];
  const d = new Date(`${desde}T12:00:00Z`), h = new Date(`${hasta}T12:00:00Z`);
  while (d <= h) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
};

/** Pagos aprobados día por día (hora de Argentina), filtrados por quien cobra o quien paga. */
async function buscarPagos(token, filtro, desde, hasta, convertir, { fetchPagina, rango = 'date_created', estado = 'approved' } = {}) {
  const pagina = fetchPagina || ((url) => pedir(url, { token }));
  const filas = [];
  for (const dia of diasEntre(desde, hasta)) {
    let offset = 0;
    for (;;) {
      const q = new URLSearchParams({
        sort: rango, criteria: 'asc', range: rango,
        begin_date: `${dia}T00:00:00.000-03:00`, end_date: `${dia}T23:59:59.999-03:00`,
        limit: '100', offset: String(offset),
      });
      if (estado) q.set('status', estado);
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
    ref: String(p.external_reference || '').trim() || null,
  };
}

/** Pagos cobrados que cambiaron en esas fechas (por fecha de actualización, así entra la devolución
 *  de un cobro viejo) y que son devolución, contracargo o disputa. */
function traerDevoluciones(token, mpUserId, desde, hasta, opciones) {
  return buscarPagos(token, { 'collector.id': mpUserId }, desde, hasta, devolucionAFila,
    { ...opciones, rango: 'date_last_updated', estado: null });
}

/** Junta las devoluciones nuevas con las guardadas (una fila por pago). Devuelve las que no estaban. */
async function guardarDevoluciones(businessId, sucursal, filasNuevas, db = pool) {
  const viejas = await leerFuente(businessId, sucursal, 'devoluciones', db);
  const porId = new Map(viejas.map((x) => [x.id, x]));
  const aviso = [];
  filasNuevas.forEach((x) => {
    const antes = porId.get(x.id);
    if (!antes || antes.tipo !== x.tipo || antes.imp !== x.imp) aviso.push(x);
    porId.set(x.id, x);
  });
  const todas = [...porId.values()].sort((a, b) => `${a.fecha} ${a.hora || ''}`.localeCompare(`${b.fecha} ${b.hora || ''}`));
  if (filasNuevas.length) await escribirFuente(businessId, sucursal, 'devoluciones', todas, 'Mercado Pago', db);
  return { total: todas.length, nuevas: aviso };
}

function traerPagosHechos(token, mpUserId, desde, hasta, opciones) {
  return buscarPagos(token, { 'payer.id': mpUserId }, desde, hasta, (p) => pagoHechoAFila(p, mpUserId), opciones);
}

async function leerFuente(businessId, sucursal, tipo, db = pool) {
  const { rows } = await db.query(
    'SELECT filas FROM conciliacion_fuentes WHERE business_id = $1 AND sucursal = $2 AND tipo = $3', [businessId, sucursal, tipo]);
  return rows[0]?.filas || [];
}

async function escribirFuente(businessId, sucursal, tipo, filas, archivo, db = pool) {
  const fechas = filas.map((x) => x.fecha).filter(Boolean).sort();
  await db.query(
    `INSERT INTO conciliacion_fuentes (business_id, sucursal, tipo, archivo, filas, cantidad, desde, hasta, origen, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, 'mercadopago', now())
     ON CONFLICT (business_id, sucursal, tipo) DO UPDATE SET archivo = EXCLUDED.archivo, filas = EXCLUDED.filas,
       cantidad = EXCLUDED.cantidad, desde = EXCLUDED.desde, hasta = EXCLUDED.hasta, origen = 'mercadopago', updated_at = now()`,
    [businessId, sucursal, tipo, archivo, JSON.stringify(filas), filas.length, fechas[0] || null, fechas[fechas.length - 1] || null]);
}

/** Egresos: reemplaza los de ese origen ('pago' | 'reporte') en el rango y deja el resto. */
async function guardarEgresos(businessId, sucursal, desde, hasta, origen, nuevas, db = pool, cuenta = null) {
  // Con varias cuentas, el reporte de una cuenta reemplaza solo lo de esa cuenta.
  const deEsta = (x) => cuenta == null || x.cuenta == null || String(x.cuenta) === String(cuenta);
  const viejas = (await leerFuente(businessId, sucursal, 'egresos', db))
    .filter((x) => !(x.origen === origen && x.fecha >= desde && x.fecha <= hasta && deEsta(x)));
  const todas = [...viejas, ...nuevas].sort((a, b) => `${a.fecha} ${a.hora || ''}`.localeCompare(`${b.fecha} ${b.hora || ''}`));
  await escribirFuente(businessId, sucursal, 'egresos', todas, `Mercado Pago ${desde} a ${hasta}`, db);
  return todas.length;
}

/**
 * Reporte de liberaciones (14/11): nombres de quienes transfirieron y egresos (retiros,
 * impuestos, comisiones…). MP lo arma en unos minutos: la primera vez queda "pendiente" y el
 * front vuelve a preguntar.
 */
async function aplicarReporte(businessId, sucursal, desde, hasta, { tokenListo, cuenta = null } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(desde || '') || !/^\d{4}-\d{2}-\d{2}$/.test(hasta || '') || desde > hasta) {
    return { error: 'fechas_invalidas' };
  }
  if (!tokenListo && cuenta == null) {
    const lista = await filas(businessId, sucursal);
    if (lista.length > 1) {
      const rs = [];
      for (const c of lista) rs.push(await aplicarReporte(businessId, sucursal, desde, hasta, { cuenta: c.mp_user_id }));
      const pend = rs.find((r) => r.reporte === 'pendiente');
      return pend || rs.find((r) => r.reporte === 'listo') || rs[0];
    }
  }
  const t = tokenListo || await tokenVigente(businessId, sucursal, cuenta);
  if (t.error) return t;
  try {
    const cfg = await reportes.asegurarConfig(t.token);
    if (cfg.error) return { reporte: 'error', motivo: cfg.error };
    const b = await reportes.buscarOPedir(t.token, desde, hasta);
    if (b.error) return { reporte: 'error', motivo: b.error };
    if (b.pendiente) return { reporte: 'pendiente' };
    const d = await reportes.bajar(t.token, b.archivo);
    if (d.error) return { reporte: 'error', motivo: d.error };
    const { nombres, docs, egresos } = reportes.analizar(reportes.parsearCSV(d.csv));
    // Nombres (y CUIT/DNI) en los cobros que vinieron sin eso.
    let conNombre = 0, cambios = 0;
    if (nombres.size || docs.size) {
      const banco = await leerFuente(businessId, sucursal, 'banco');
      banco.forEach((x) => {
        const n = x.mpId != null ? nombres.get(String(x.mpId)) : null;
        if (n && !x.cliente) { x.cliente = n; conNombre += 1; cambios += 1; }
        const dc = x.mpId != null ? docs.get(String(x.mpId)) : null;
        if (dc && !x.doc) { x.doc = dc; cambios += 1; }
      });
      // También en lo guardado entero, así sobrevive al rearmar las filas.
      const extras = [...new Set([...nombres.keys(), ...docs.keys()])].filter((id) => /^\d+$/.test(id))
        .map((id) => ({ id, nombre: nombres.get(id) || null, doc: docs.get(id) || null }));
      if (extras.length) {
        await pool.query(
          `UPDATE mp_pagos m SET extra = COALESCE(m.extra, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object('nombre', x->>'nombre', 'doc', x->>'doc'))
             FROM jsonb_array_elements($3::jsonb) x
            WHERE m.business_id = $1 AND m.sucursal = $2 AND m.rol = 'cobro' AND m.mp_id = (x->>'id')::bigint`,
          [businessId, sucursal, JSON.stringify(extras)]);
      }
      if (cambios) {
        await pool.query(
          "UPDATE conciliacion_fuentes SET filas = $3::jsonb, updated_at = now() WHERE business_id = $1 AND sucursal = $2 AND tipo = 'banco'",
          [businessId, sucursal, JSON.stringify(banco)]);
      }
    }
    egresos.forEach((x) => { x.cuenta = t.fila.mp_user_id; });
    await guardarEgresos(businessId, sucursal, desde, hasta, 'reporte', egresos, pool, t.fila.mp_user_id);
    return { reporte: 'listo', nombres: conNombre, egresos: egresos.length };
  } catch (e) {
    return { reporte: 'error', motivo: 'mp_reporte_fallo', detalle: e.message };
  }
}

// ── Todo lo que manda Mercado Pago, guardado entero (Diego 14/11/2026) ──────────────────────
// «Cuando trae lo de bancos debe traer todo, no parcial con algunas columnas; y si MP suma una
// columna, hacer el barrido hacia atrás para todos los registros». Cada pago se guarda COMPLETO en
// mp_pagos (raw). Las filas que leen la conciliación y Movimientos bancarios (banco, egresos,
// devoluciones) se arman desde ahí: sumar una columna = subir VERSION_FILAS y se rearman todas las
// filas desde lo guardado, sin volver a pedirle nada a MP (mercadopagoDiario.js).
const VERSION_FILAS = 3; // 3 (15/11): cada fila dice de qué cuenta de MP viene (varias cuentas por sucursal)
const restarDiasIso = (iso, n) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };

/** Saca de lo que manda MP lo que pesa y no sirve (imágenes del QR). */
function aligerar(p) {
  const x = JSON.parse(JSON.stringify(p));
  const td = x.point_of_interaction?.transaction_data;
  if (td) { delete td.qr_code_base64; delete td.qr_code; }
  return x;
}

/** Guarda (o actualiza) los pagos tal cual vienen de MP. rol: 'cobro' (cobró la cuenta) | 'pago' (pagó). */
async function guardarCrudos(businessId, sucursal, rol, pagos, db = pool, cuenta = null) {
  const lista = pagos.filter((p) => p && p.id != null);
  for (let i = 0; i < lista.length; i += 400) {
    const tanda = lista.slice(i, i + 400).map((p) => ({ ...aligerar(p), _fecha: enAR(p.date_created)?.fecha || null }));
    await db.query(
      `INSERT INTO mp_pagos (business_id, sucursal, rol, mp_id, fecha, estado, raw, actualizado, cuenta)
       SELECT $1, $2, $3, (x->>'id')::bigint, (x->>'_fecha')::date, x->>'status', x - '_fecha', now(), $5::bigint
         FROM jsonb_array_elements($4::jsonb) x
       ON CONFLICT (business_id, sucursal, mp_id, rol) DO UPDATE
         SET raw = EXCLUDED.raw, estado = EXCLUDED.estado, fecha = EXCLUDED.fecha, actualizado = now(),
             cuenta = COALESCE(EXCLUDED.cuenta, mp_pagos.cuenta)`,
      [businessId, sucursal, rol, JSON.stringify(tanda), cuenta]);
  }
  return lista.length;
}

/** Pagos crudos de la cuenta (cualquier estado menos rechazados/cancelados). */
async function traerCrudos(token, filtro, desde, hasta, rango = 'date_created', opciones = {}) {
  const todos = await buscarPagos(token, filtro, desde, hasta, (p) => p, { ...opciones, rango, estado: null });
  return todos.filter((p) => !['rejected', 'cancelled'].includes(p.status));
}

/** Lo que agregó el reporte de liberaciones a un pago (nombre, documento). */
const conExtra = (fila, extra) => {
  if (!fila || !extra) return fila;
  if (extra.nombre && !fila.cliente) fila.cliente = extra.nombre;
  if (extra.doc && !fila.doc) fila.doc = extra.doc;
  return fila;
};

/**
 * Arma las filas de banco, egresos (pagos hechos) y devoluciones de un rango desde lo guardado
 * en mp_pagos y las deja en conciliacion_fuentes. Con candado por cuenta: dos traídas a la vez
 * no se pisan.
 */
async function derivarRango(businessId, sucursal, mpUserId, desde, hasta) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`mpfuentes:${businessId}:${sucursal}`]);
    const { rows } = await client.query(
      `SELECT rol, raw, extra, cuenta::text AS cuenta FROM mp_pagos
        WHERE business_id = $1 AND sucursal = $2
          AND (fecha BETWEEN ($3::date - 1) AND $4::date
               OR (rol = 'cobro' AND (raw->>'date_last_updated') >= $5::text AND (raw->>'date_last_updated') < $6::text))`,
      [businessId, sucursal, desde, hasta, desde, restarDiasIso(hasta, -2)]);
    const enRango = (f) => f && f.fecha >= desde && f.fecha <= hasta;
    const banco = [], hechos = [], devol = [];
    rows.forEach((r) => {
      // Todas las cuentas de la sucursal juntas; cada fila dice de qué cuenta es (varias cuentas, 15/11).
      const cta = r.cuenta || (mpUserId != null ? String(mpUserId) : null);
      if (r.rol === 'cobro') {
        const f = conExtra(pagoAFila(r.raw), r.extra);
        if (f && cta) f.cuenta = cta;
        if (enRango(f)) banco.push(f);
        const d = devolucionAFila(r.raw);
        if (d && cta) d.cuenta = cta;
        if (d) devol.push(d);
      } else {
        const f = pagoHechoAFila(r.raw, cta);
        if (f && cta) f.cuenta = cta;
        if (enRango(f)) hechos.push(f);
      }
    });
    // banco: reemplaza el rango
    const viejas = (await leerFuente(businessId, sucursal, 'banco', client)).filter((x) => !(x.fecha >= desde && x.fecha <= hasta));
    const todas = [...viejas, ...banco].sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));
    todas.forEach((x, i) => { x.ord = i; });
    await escribirFuente(businessId, sucursal, 'banco', todas, `Mercado Pago ${desde} a ${hasta}`, client);
    await guardarEgresos(businessId, sucursal, desde, hasta, 'pago', hechos, client);
    const dev = await guardarDevoluciones(businessId, sucursal, devol, client);
    await client.query('COMMIT');
    return { cobros: banco.length, total: todas.length, pagos_hechos: hechos.length, devoluciones: dev.total, devolucionesNuevas: dev.nuevas };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Pide a MP todo lo del rango y lo guarda entero (sin armar filas). Devuelve cuántos pagos guardó. */
async function traerYGuardar(t, businessId, sucursal, desde, hasta) {
  const quien = t.fila.mp_user_id;
  const cobros = await traerCrudos(t.token, { 'collector.id': quien }, desde, hasta, 'date_created');
  await guardarCrudos(businessId, sucursal, 'cobro', cobros, pool, quien);
  // Los que cambiaron en el rango (devoluciones y contracargos de cobros más viejos).
  const cambiados = await traerCrudos(t.token, { 'collector.id': quien }, desde, hasta, 'date_last_updated');
  await guardarCrudos(businessId, sucursal, 'cobro', cambiados, pool, quien);
  let pagos = [];
  try {
    pagos = await traerCrudos(t.token, { 'payer.id': quien }, desde, hasta, 'date_created');
    await guardarCrudos(businessId, sucursal, 'pago', pagos, pool, quien);
  } catch (e) {
    console.warn('[mercadopago] pagos hechos:', e.message);
  }
  return { cobros: cobros.length, cambiados: cambiados.length, pagos: pagos.length };
}

/**
 * Trae TODO lo del período (guardado entero) y arma las filas de banco, egresos y devoluciones:
 * reemplaza lo que había de esas fechas (venga de archivo o de MP) y deja el resto.
 */
async function sincronizarBanco(businessId, sucursal, desde, hasta, { sinReporte = false, cuenta = null } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(desde || '') || !/^\d{4}-\d{2}-\d{2}$/.test(hasta || '') || desde > hasta) {
    return { error: 'fechas_invalidas' };
  }
  if (diasEntre(desde, hasta).length > MAX_DIAS) return { error: 'periodo_muy_largo' };
  // Sin cuenta pedida y con varias en la sucursal: trae cada una y suma (una tras otra).
  if (cuenta == null) {
    const lista = await filas(businessId, sucursal);
    if (lista.length > 1) {
      const rs = [];
      for (const c of lista) rs.push(await sincronizarBanco(businessId, sucursal, desde, hasta, { sinReporte, cuenta: c.mp_user_id }));
      const ok = rs.filter((r) => !r.error);
      if (!ok.length) return rs[0];
      const suma = (k) => ok.reduce((a, r) => a + (Number(r[k]) || 0), 0);
      const ult = ok[ok.length - 1];
      const rep = ok.find((r) => r.reporte === 'pendiente') || ok.find((r) => r.reporte === 'listo') || {};
      return {
        ok: true, desde, hasta, cuentas: lista.length, crudos: suma('crudos'), cobros: suma('cobros'), total: ult.total,
        pagos_hechos: ult.pagos_hechos, devoluciones: ult.devoluciones, reporte: rep.reporte, egresos: suma('egresos'), nombres: suma('nombres'),
        errores: rs.filter((r) => r.error).map((r) => r.error),
      };
    }
  }
  const t = await tokenVigente(businessId, sucursal, cuenta);
  if (t.error) return t;
  let traido;
  try {
    traido = await traerYGuardar(t, businessId, sucursal, desde, hasta);
  } catch (e) {
    await pool.query('UPDATE integraciones_mercadopago SET ultimo_sync_error = $2, updated_at = now() WHERE business_id = $1 AND sucursal = $3 AND mp_user_id = $4',
      [businessId, String(e.message || e).slice(0, 300), sucursal, t.fila.mp_user_id]);
    return { error: 'mp_fallo_consulta', detalle: e.message };
  }
  const d = await derivarRango(businessId, sucursal, t.fila.mp_user_id, desde, hasta);
  if (d.devolucionesNuevas.length) avisarDevoluciones(businessId, d.devolucionesNuevas);
  // El recorrido del historial (sinReporte) va mes por mes hacia atrás: no cuenta como «últimos traídos»
  // (si no, Conexiones mostraba «del 01/09/2025 al 30/09/2025» aunque hoy ya estaba traído).
  await pool.query(
    sinReporte
      ? `UPDATE integraciones_mercadopago SET ultimo_sync_error = NULL, updated_at = now()
          WHERE business_id = $1 AND sucursal = $4 AND mp_user_id = $5 AND $2::date IS NOT NULL AND $3::date IS NOT NULL`
      : `UPDATE integraciones_mercadopago SET ultimo_sync_at = now(), ultimo_sync_desde = $2, ultimo_sync_hasta = $3,
       ultimo_sync_error = NULL, updated_at = now() WHERE business_id = $1 AND sucursal = $4 AND mp_user_id = $5`,
    [businessId, desde, hasta, sucursal, t.fila.mp_user_id]);
  const rep = sinReporte ? {} : await aplicarReporte(businessId, sucursal, desde, hasta, { tokenListo: t, cuenta: t.fila.mp_user_id });
  return { ok: true, desde, hasta, crudos: traido.cobros, cobros: d.cobros, total: d.total, pagos_hechos: d.pagos_hechos, devoluciones: d.devoluciones, ...rep };
}

/**
 * Barrido hacia atrás sin pedirle nada a MP: rearma todas las filas de una cuenta desde lo
 * guardado (cuando cambia VERSION_FILAS). Mes por mes, solo los meses que tienen pagos guardados.
 */
async function rederivarCuenta(businessId, sucursal) {
  const f = await fila(businessId, sucursal);
  if (!f) return { error: 'mp_no_conectado' };
  const { rows } = await pool.query(
    `SELECT DISTINCT to_char(date_trunc('month', fecha), 'YYYY-MM-DD') AS mes FROM mp_pagos
      WHERE business_id = $1 AND sucursal = $2 AND fecha IS NOT NULL ORDER BY 1`, [businessId, sucursal]);
  for (const { mes } of rows) {
    const fin = new Date(`${mes}T12:00:00Z`); fin.setUTCMonth(fin.getUTCMonth() + 1); fin.setUTCDate(0);
    await derivarRango(businessId, sucursal, f.mp_user_id, mes, fin.toISOString().slice(0, 10));
  }
  await pool.query('UPDATE integraciones_mercadopago SET version_filas = $3 WHERE business_id = $1 AND sucursal = $2',
    [businessId, sucursal, VERSION_FILAS]);
  return { meses: rows.length };
}

/** Un aviso en la campana por tanda (no uno por devolución). */
function avisarDevoluciones(businessId, filas) {
  const { avisarAlEquipoSinEsperar } = require('./notificationService');
  const pesos = (n) => `$${Math.round(n).toLocaleString('es-AR')}`;
  const total = filas.reduce((a, x) => a + (Number(x.imp) || 0), 0);
  const cuenta = (t) => filas.filter((x) => x.tipo === t).length;
  const partes = [['Devolución', 'devolución', 'devoluciones'], ['Contracargo', 'contracargo', 'contracargos'], ['En disputa', 'disputa', 'disputas']]
    .map(([t, uno, varios]) => { const n = cuenta(t); return n ? `${n} ${n === 1 ? uno : varios}` : null; }).filter(Boolean);
  avisarAlEquipoSinEsperar({
    businessId, type: 'mercadopago_devolucion', incluirActor: false,
    title: `Mercado Pago: ${partes.join(', ')} (${pesos(total)})`,
    message: filas.slice(0, 5).map((x) => `${x.tipo} ${pesos(x.imp)}${x.cliente ? ` · ${x.cliente}` : ''} (cobro del ${x.cobroFecha || '—'})`).join('\n'),
    metadata: { link: '/movimientos-bancarios', ids: filas.map((x) => x.mpId).slice(0, 50) },
  });
}

module.exports = {
  VERSION_FILAS, rederivarCuenta, traerYGuardar, derivarRango,
  configurado, urlAutorizacion, conectar, estado, desconectar, tokenVigente, filas, sincronizarBanco, aplicarReporte,
  // para tests
  _firmarEstado: firmarEstado, _verificarEstado: verificarEstado, _pagoAFila: pagoAFila, _traerCobros: traerCobros, _enAR: enAR,
  _pagoHechoAFila: pagoHechoAFila, _traerPagosHechos: traerPagosHechos,
  _devolucionAFila: devolucionAFila, _guardarCrudos: guardarCrudos, _descuentosDe: descuentosDe, _extrasDePago: extrasDePago,
};
