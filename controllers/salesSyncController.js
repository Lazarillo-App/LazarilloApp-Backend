// controllers/salesSyncController.js
/* eslint-disable no-console */
const pool = require('../config/db');
const { decryptSecretCompat } = require('../utils/cryptoField');

/* ========== Fetch c/timeout y reintentos ========== */
const fetchNative =
  (typeof globalThis.fetch === 'function')
    ? ((...args) => globalThis.fetch(...args))
    : require('node-fetch');

const BASE = (process.env.MAXI_BASE_URL || 'https://api-mconn.maxisistemas.com.ar').replace(/\/+$/, '');
const FETCH_TIMEOUT_MS = Number(process.env.MAXI_FETCH_TIMEOUT_MS || 30000);
const FETCH_RETRIES    = Number(process.env.MAXI_FETCH_RETRIES || 2);

async function fetchWithRetry(url, options = {}, { retries = FETCH_RETRIES, timeout = FETCH_TIMEOUT_MS } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort('timeout'), timeout);
    try {
      const res = await fetchNative(url, { ...options, signal: ctrl.signal });
      clearTimeout(t);
      if (res.ok) return res;
      if ([429,500,502,503,504].includes(res.status) && attempt < retries) {
        const delay = 200 * (attempt + 1) ** 2;
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      const txt = await res.text().catch(() => '');
      const err = new Error(`HTTP ${res.status} - ${txt.slice(0,200)}`);
      err.status = res.status;
      throw err;
    } catch (e) {
      clearTimeout(t);
      lastErr = e;
      if (attempt < retries) {
        const delay = 200 * (attempt + 1) ** 2;
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr || new Error('fetchWithRetry unknown error');
}

/* ========== Fechas y helpers ========== */
function ymd(d) {
  if (!(d instanceof Date) || Number.isNaN(+d)) d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function parseDate(zd, fallback) {
  if (zd == null || zd === '') return new Date(fallback);
  const d = (zd instanceof Date) ? zd : new Date(String(zd));
  return Number.isNaN(+d) ? new Date(fallback) : d;
}
function addDays(d, n) {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}
function last7dUntilYesterday() {
  const y = addDays(new Date(), -1);
  const from = addDays(y, -6);
  return { from, to: y };
}

/* ========== Credenciales Maxi desde biz.props ========== */
function loadMaxiCredsFromBiz(biz) {
  const props = biz?.props || {};
  const mx = props.maxi || props.maxi_credentials || {};
  const email  = mx.email  || mx.user   || null;
  const codcli = mx.codcli || mx.codigo || null;

  const secret = mx.pass_enc ?? mx.password_enc ?? mx.password ?? mx.pass ?? null;
  const pass = decryptSecretCompat(secret);

  if (!email || !pass || !codcli) {
    const err = new Error('missing_maxi_credentials');
    err.status = 400;
    throw err;
  }
  return { email, pass, codcli };
}

/* ========== Maxi: login y fetch ventas ========== */
async function maxiLogin({ email, pass, codcli }) {
  const url = `${BASE}/login`;
  const body = { email, pass, cod_cli: String(codcli) };
  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'Accept':'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  const ok = data?.resultCode === 'SUCCESS' && data?.content?.tokenAccess;
  if (!ok) {
    const msg = data?.resultDescription || `login_failed_${res.status}`;
    const err = new Error(msg);
    err.status = 502;
    throw err;
  }
  return data.content.tokenAccess;
}

/**
 * Trae ventas en rango [from..to] (UTC, formato YYYY-MM-DD).
 * Ajustá la ruta si tu instancia usa otro endpoint para ventas.
 * Intentamos varios formatos comunes del payload.
 */
async function maxiFetchSalesRanged({ token, codcli, from, to }) {
  // Ruta típica para estadísticas por rango: /estadisticas/ventas (ajustá si difiere)
  const u = new URL(`${BASE}/estadisticas/ventas`);
  u.searchParams.set('cod_cli', String(codcli));
  u.searchParams.set('from', ymd(from));
  u.searchParams.set('to',   ymd(to));

  const res = await fetchWithRetry(u.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  const d = await res.json().catch(() => ({}));

  // Normalizamos una lista de items de venta con: fecha, articulo_id, qty, importe
  const candidates = [
    d?.content?.ventas, d?.ventas, d?.items, d?.data, d,
  ];
  const rows = (candidates.find(Array.isArray) || []).map(x => normalizeSaleItem(x));

  // Filtramos nulos
  return rows.filter(Boolean);
}

function normalizeSaleItem(x) {
  try {
    // Campos habituales con alias
    const fecha = x.fecha || x.date || x.dia || x.day || x.fecha_venta;
    const articuloId = Number(
      x.articulo_id ?? x.id_articulo ?? x.codart ?? x.codigoArticulo ?? x.codigo ?? x.id
    );
    const qty = Number(x.cantidad ?? x.qty ?? x.unidades ?? x.cant ?? 0) || 0;
    const importe = Number(x.importe ?? x.total ?? x.monto ?? x.venta ?? 0) || 0;

    // Algunas APIs agrupan ventas por artículo/fecha; si viene precio unitario:
    // const precioUnit = Number(x.precio ?? x.precio_unitario ?? 0);

    if (!fecha || !Number.isFinite(articuloId)) return null;
    // Normalizamos fecha a YYYY-MM-DD
    const d = new Date(fecha);
    const f = Number.isNaN(+d) ? ymd(new Date()) : ymd(d);
    return { fecha: f, articulo_id: articuloId, qty, importe };
  } catch {
    return null;
  }
}

/* ========== Upsert a public.maxi_sales_daily ========== */
/**
 * Upsert masivo por (business_id, fecha, articulo_id).
 * Columnas sugeridas: business_id, fecha, articulo_id, qty, importe, updated_at.
 * Si tu tabla se llama distinto o tiene más columnas, ajusta el SQL.
 */
async function upsertSalesBatch({ client, businessId, sales }) {
  if (!sales?.length) return { upserted: 0, updated: 0 };

  const CHUNK = 1000;
  let upserted = 0;
  for (let i = 0; i < sales.length; i += CHUNK) {
    const slice = sales.slice(i, i + CHUNK);

    const values = [];
    const params = [];
    let p = 1;

    for (const s of slice) {
      if (!s?.fecha || !Number.isFinite(s?.articulo_id)) continue;
      values.push(`($${p}, $${p+1}, $${p+2}, $${p+3}, $${p+4}, NOW())`);
      params.push(
        businessId,
        s.fecha,
        s.articulo_id,
        Number(s.qty || 0),
        Number(s.importe || 0),
      );
      p += 5;
    }
    if (!values.length) continue;

    const sql = `
      INSERT INTO public.maxi_sales_daily
        (business_id, fecha, articulo_id, qty, importe, updated_at)
      VALUES ${values.join(',')}
      ON CONFLICT (business_id, fecha, articulo_id)
      DO UPDATE SET
        qty       = EXCLUDED.qty,
        importe   = EXCLUDED.importe,
        updated_at= NOW()
    `;
    await client.query(sql, params);
    upserted += slice.length;
  }
  // Nota: "updated" exacto requeriría RETURNING o diff previo; devolvemos upserted total.
  return { upserted, updated: 0 };
}

/* ========== Endpoints/exports ========== */

/**
 * Diagnóstico simple: intenta login y contesta estado.
 * Uso típico: GET /businesses/:id/maxi-ping
 */
exports.maxiPing = async (req, res) => {
  try {
    const biz = req.business;
    const { email, pass, codcli } = loadMaxiCredsFromBiz(biz);
    const token = await maxiLogin({ email, pass, codcli });
    res.json({ ok: true, connected: !!token, email, codcli });
  } catch (e) {
    const status = e.status || (String(e.message || '').includes('401') ? 401 : 500);
    res.status(status).json({ ok: false, error: e.message || 'maxi_ping_failed' });
  }
};

/**
 * Punto de entrada usado por routes/businessRoutes.js:
 *   const out = await syncSalesForBusiness(biz, { mode, from, to, dryrun, req });
 *
 * modes:
 *  - 'auto'           → usa rango recibido (from/to) o calcula 7d hasta ayer si faltan.
 *  - 'backfill_30d'   → ignora from/to y trae últimos 30 días (hasta ayer).
 */
exports.syncSalesForBusiness = async function syncSalesForBusiness(biz, { mode = 'auto', from, to, dryrun = false } = {}) {
  if (!biz?.id) {
    const err = new Error('no_active_business');
    err.status = 400;
    throw err;
  }

  // Rango
  let dFrom, dTo;
  if (mode === 'backfill_30d') {
    const { to: y, from: f } = (function () {
      const y = addDays(new Date(), -1);
      return { from: addDays(y, -29), to: y };
    })();
    dFrom = f; dTo = y;
  } else {
    if (from && to) {
      dFrom = parseDate(from, addDays(new Date(), -7));
      dTo   = parseDate(to,   addDays(new Date(), -1));
    } else {
      const r = last7dUntilYesterday();
      dFrom = r.from; dTo = r.to;
    }
  }

  // Credenciales y login
  const { email, pass, codcli } = loadMaxiCredsFromBiz(biz);
  const token = await maxiLogin({ email, pass, codcli });

  // Fetch ventas
  const sales = await maxiFetchSalesRanged({ token, codcli, from: dFrom, to: dTo });

  if (dryrun) {
    return { mode, from: ymd(dFrom), to: ymd(dTo), upserted: 0, updated: 0, preview_count: sales.length };
  }

  // Upsert en DB
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { upserted, updated } = await upsertSalesBatch({ client, businessId: biz.id, sales });
    await client.query('COMMIT');
    return { mode, from: ymd(dFrom), to: ymd(dTo), upserted, updated };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('syncSalesForBusiness error:', e);
    const err = new Error(e.message || 'sales_sync_failed');
    err.status = e.status || 500;
    throw err;
  } finally {
    client.release();
  }
};
