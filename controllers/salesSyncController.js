/* eslint-disable no-console */
const pool = require('../config/db');
const { decryptSecretCompat } = require('../utils/cryptoField');

// fetch nativo o fallback
const fetchNative =
  (typeof globalThis.fetch === 'function')
    ? ((...args) => globalThis.fetch(...args))
    : require('node-fetch');

const BASE = (process.env.MAXI_BASE_URL || 'https://api-mconn.maxisistemas.com.ar').replace(/\/+$/, '');
const FETCH_TIMEOUT_MS = Number(process.env.MAXI_FETCH_TIMEOUT_MS || 30000);
const FETCH_RETRIES    = Number(process.env.MAXI_FETCH_RETRIES || 2);

/* ───────────── Utils de fecha ───────────── */
function parseDate(zd, fallback) {
  if (zd == null || zd === '') return new Date(fallback);
  if (zd instanceof Date)     return Number.isNaN(+zd) ? new Date(fallback) : zd;
  if (typeof zd === 'number') { const d = new Date(zd); return Number.isNaN(+d) ? new Date(fallback) : d; }
  const d = new Date(String(zd)); return Number.isNaN(+d) ? new Date(fallback) : d;
}
function ymd(d) {
  if (!(d instanceof Date) || Number.isNaN(+d)) d = new Date();
  const y = d.getUTCFullYear(), m = String(d.getUTCMonth()+1).padStart(2,'0'), day = String(d.getUTCDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}
function addDays(d, n){ const x = new Date(d); x.setUTCDate(x.getUTCDate()+n); return x; }
function clampToYesterday(rangeFrom, rangeTo) {
  const now = new Date();
  const yesterday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()-1));
  const from = new Date(rangeFrom); const to = new Date(rangeTo);
  if (to > yesterday) return { from, to: yesterday };
  return { from, to };
}

/* ───────────── Fetch con reintentos ───────────── */
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
        await new Promise(r => setTimeout(r, 200 * (attempt+1) ** 2));
        continue;
      }
      const txt = await res.text().catch(() => '');
      const err = new Error(`HTTP ${res.status} - ${txt.slice(0,200)}`); err.status = res.status;
      throw err;
    } catch (e) {
      clearTimeout(t); lastErr = e;
      if (attempt < retries) { await new Promise(r => setTimeout(r, 200 * (attempt+1) ** 2)); continue; }
      throw lastErr;
    }
  }
  throw lastErr || new Error('fetchWithRetry unknown error');
}

/* ───────────── MAXI: login ───────────── */
async function maxiLogin({ email, pass, codcli }) {
  const res = await fetchWithRetry(`${BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'Accept':'application/json' },
    body: JSON.stringify({ email, pass, cod_cli: String(codcli) })
  });
  const d = await res.json().catch(() => ({}));
  const ok = d?.resultCode === 'SUCCESS' && d?.content?.tokenAccess;
  if (!ok) { const msg = d?.resultDescription || `login_failed_${res.status}`; const err = new Error(msg); err.status = 502; throw err; }
  return d.content.tokenAccess;
}

/* ───────────── MAXI: traer ventas por rango (normalizador flexible) ─────────────
   NOTA: Maxi suele exponer varias variantes. Probamos algunas rutas conocidas:
   - /estadisticas/ventas/detalle
   - /estadisticas/ventas
   Adaptalo si tu instancia usa otra.
*/
async function maxiFetchSalesRange({ token, codcli, from, to }) {
  const endpoints = [
    // detalle por día/artículo
    (base) => {
      const u = new URL(`${base}/estadisticas/ventas/detalle`);
      u.searchParams.set('cod_cli', String(codcli));
      u.searchParams.set('fechaInicio', from);
      u.searchParams.set('fechaFin', to);
      return u.toString();
    },
    // resumen que igual trae líneas por artículo con fecha
    (base) => {
      const u = new URL(`${base}/estadisticas/ventas`);
      u.searchParams.set('cod_cli', String(codcli));
      u.searchParams.set('fechaInicio', from);
      u.searchParams.set('fechaFin', to);
      return u.toString();
    },
  ];

  let data = null;
  for (const make of endpoints) {
    try {
      const url = make(BASE);
      const res = await fetchWithRetry(url, { headers: { Authorization: `Bearer ${token}` } });
      const j = await res.json().catch(() => ({}));
      data = j; break;
    } catch (_e) { /* probar siguiente */ }
  }
  if (!data) throw new Error('maxi_sales_fetch_failed');

  // Intentar encontrar array de filas
  const arrays = [
    data?.content?.items, data?.content?.ventas, data?.ventas, data?.items, data?.content, Array.isArray(data) ? data : null
  ].filter(Array.isArray);
  const rows = arrays[0] || [];

  // Normalización
  const normNum = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const normArt = (o) => {
    const id = Number(
      o.articulo_id ?? o.idArticulo ?? o.codart ?? o.codigo ?? o.codigoArticulo ?? o.id
    );
    const dayRaw = String(
      o.day ?? o.fecha ?? o.fechaVenta ?? o.fecha_venta ?? o.dia ?? o.fechadia ?? ''
    ).slice(0, 10);
    const qty    = normNum(o.qty ?? o.cantidad ?? o.cant ?? o.cantTotal ?? o.unidades);
    const amount = normNum(o.amount ?? o.importe ?? o.total ?? o.monto);
    return { id: Number.isFinite(id) ? id : null, day: dayRaw, qty, amount };
  };

  const out = [];
  for (const r of rows) {
    const n = normArt(r);
    if (!n.id || !n.day) continue;
    out.push(n);
  }
  return out;
}

/* ───────────── UPSERT ventas diarias ───────────── */
async function upsertSalesDaily({ client, businessId, items }) {
  if (!items?.length) return { upserted: 0, updated: 0 };
  const CHUNK = 1000;
  let upserted = 0;
  let updated  = 0;

  for (let i = 0; i < items.length; i += CHUNK) {
    const slice = items.slice(i, i + CHUNK);

    const values = [];
    const params = [];
    let p = 1;

    for (const it of slice) {
      const articuloId = Number(it.id);
      const day = String(it.day).slice(0,10);
      const qty = Number(it.qty) || 0;
      const amount = Number(it.amount) || 0;
      if (!Number.isFinite(articuloId) || !day) continue;

      values.push(`($${p},$${p+1}::date,$${p+2},$${p+3},NOW())`);
      params.push(businessId, day, articuloId, qty || amount ? amount : 0); // amount (ver nota abajo)
      // NOTA: si tu tabla tiene (qty, amount) por separado, ver SQL debajo.
      p += 4;
    }
    if (!values.length) continue;

    // Si tu tabla tiene qty y amount por separado, usa la versión extendida de SQL (ver más abajo).
    const sql = `
      INSERT INTO public.maxi_sales_daily (business_id, day, articulo_id, amount, updated_at)
      VALUES ${values.join(',')}
      ON CONFLICT (business_id, day, articulo_id)
      DO UPDATE SET
        amount = EXCLUDED.amount,
        updated_at = NOW()
      RETURNING (xmax <> 0) AS was_update
    `;

    const r = await client.query(sql, params);
    const updates = r.rows.filter(row => row.was_update).length;
    updated  += updates;
    upserted += (r.rowCount - updates);
  }
  return { upserted, updated };
}

/* ───────────── Credenciales desde props ───────────── */
function loadMaxiCredsFromBiz(biz) {
  const props = biz?.props || {};
  const mx = props.maxi || props.maxi_credentials || {};
  const email = mx.email || mx.user || null;
  const codcli = mx.codcli || mx.codigo || null;
  const secret =
    mx.pass_enc ?? mx.password_enc ?? mx.password ?? mx.pass ?? null;
  const pass = decryptSecretCompat(secret);
  if (!email || !pass || !codcli) {
    const err = new Error('maxi_not_configured'); err.status = 400; throw err;
  }
  return { email, pass, codcli };
}

/* ===================== Handlers exportados ===================== */

// GET /businesses/:id/maxi-ping
exports.maxiPing = async (req, res) => {
  const biz = req.business;
  const out = { configured: false, connected: false };
  try {
    const { email, pass, codcli } = loadMaxiCredsFromBiz(biz);
    out.configured = true;
    const token = await maxiLogin({ email, pass, codcli });
    out.connected = !!token;
    return res.json({ ok: true, configured: out.configured, connected: out.connected, email, codcli });
  } catch (e) {
    if (String(e?.message).includes('maxi_not_configured')) {
      return res.json({ ok: true, configured: false, connected: false });
    }
    console.warn('maxiPing err:', e?.message || e);
    return res.json({ ok: false, configured: out.configured, connected: false, error: e?.message || 'ping_failed' });
  }
};

// Usado por routes: router.post('/:id/sync-sales', ...)
exports.syncSalesForBusiness = async (biz, { mode = 'auto', from, to, dryrun = false } = {}) => {
  if (!biz?.id) { const e = new Error('no_active_business'); e.status = 400; throw e; }

  // Rango por defecto: últimos 7 días hasta AYER
  const today = new Date();
  const defTo = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()-1));
  const defFrom = addDays(defTo, -6);

  const f = parseDate(from, defFrom);
  const t = parseDate(to,   defTo);
  const { from: F, to: T } = clampToYesterday(ymd(f), ymd(t));

  const client = await pool.connect();
  try {
    const { email, pass, codcli } = loadMaxiCredsFromBiz(biz);
    const token = await maxiLogin({ email, pass, codcli });

    const rows = await maxiFetchSalesRange({ token, codcli, from: ymd(F), to: ymd(T) });

    if (dryrun) {
      return { from: ymd(F), to: ymd(T), upserted: 0, updated: 0, preview: rows.slice(0, 5) };
    }

    await client.query('BEGIN');
    // 🚨 IMPORTANTE: ajusta `upsertSalesDaily` si tu tabla tiene columnas qty y amount separadas
    const { upserted, updated } = await upsertSalesDaily({ client, businessId: biz.id, items: rows });
    await client.query('COMMIT');

    return { from: ymd(F), to: ymd(T), upserted, updated };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('syncSalesForBusiness error:', e?.stack || e);
    const err = new Error(e?.message || 'sales_sync_failed'); err.status = e.status || 500; throw err;
  } finally {
    client.release();
  }
};
