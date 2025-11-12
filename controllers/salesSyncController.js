/* eslint-disable no-console */
'use strict';

const pool = require('../config/db');
const { decryptSecretCompat } = require('../utils/cryptoField');

// fetch nativo o fallback
const fetchNative = (typeof globalThis.fetch === 'function')
  ? ((...args) => globalThis.fetch(...args))
  : require('node-fetch');

const BASE = (process.env.MAXI_BASE_URL || 'https://api-mconn.maxisistemas.com.ar').replace(/\/+$/, '');
const FETCH_TIMEOUT_MS = Number(process.env.MAXI_FETCH_TIMEOUT_MS || 30000);
const FETCH_RETRIES    = Number(process.env.MAXI_FETCH_RETRIES || 2);

/* ───────────── Utils de fecha ───────────── */
function parseDate(zd, fallback) {
  if (zd == null || zd === '') return new Date(fallback);
  if (zd instanceof Date) return Number.isNaN(+zd) ? new Date(fallback) : zd;
  if (typeof zd === 'number') { const d = new Date(zd); return Number.isNaN(+d) ? new Date(fallback) : d; }
  const d = new Date(String(zd)); return Number.isNaN(+d) ? new Date(fallback) : d;
}
function ymd(d) {
  if (!(d instanceof Date) || Number.isNaN(+d)) d = new Date();
  const y = d.getUTCFullYear(), m = String(d.getUTCMonth() + 1).padStart(2, '0'), day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function addDays(d, n) { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; }
function clampToYesterday(fromDate, toDate) {
  const y = new Date(); y.setUTCDate(y.getUTCDate() - 1);
  const from = new Date(fromDate); const to = new Date(toDate);
  return { from, to: to > y ? y : to };
}

/* ────────────────────────────────────────────────────────────── */
/* 1) Mapeo: conciliar líneas de ventas con artículos del catálogo */
/* ────────────────────────────────────────────────────────────── */
async function reconcileSalesMappings(client, businessId, { from, to }) {
  // 1) por SKU / código exacto
  await client.query(`
    UPDATE app_sales_items si
    SET article_id = m.article_id
    FROM app_sales s
    JOIN maxi_article_map m
      ON m.business_id = s.business_id
     AND m.external_code IS NOT NULL
   WHERE s.id = si.sale_id
     AND s.business_id = $1
     AND si.article_id IS NULL
     AND si.sku IS NOT NULL            -- ⚠️ cambia a si.code si tu columna se llama "code"
     AND si.sku = m.external_code
     AND (s.occurred_at AT TIME ZONE 'UTC')::date BETWEEN $2::date AND $3::date
  `, [businessId, from, to]);

  // 2) por nombre normalizado
  await client.query(`
    UPDATE app_sales_items si
    SET article_id = m.article_id
    FROM app_sales s
    JOIN maxi_article_map m
      ON m.business_id = s.business_id
   WHERE s.id = si.sale_id
     AND s.business_id = $1
     AND si.article_id IS NULL
     AND si.name IS NOT NULL           -- ⚠️ cambia a si.article_name si tu columna se llama así
     AND lower(unaccent(si.name)) = lower(unaccent(m.title))
     AND (s.occurred_at AT TIME ZONE 'UTC')::date BETWEEN $2::date AND $3::date
  `, [businessId, from, to]);
}

/* ───────────── Fetch con reintentos ───────────── */
async function fetchWithRetry(url, options = {}, { retries = FETCH_RETRIES, timeout = FETCH_TIMEOUT_MS } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort('timeout'), timeout);
    try {
      const res = await fetchNative(url, { ...options, signal: ctrl.signal });
      clearTimeout(t);
      if (res.ok) return res;
      if ([429, 500, 502, 503, 504].includes(res.status) && i < retries) {
        await new Promise(r => setTimeout(r, 200 * (i + 1) ** 2));
        continue;
      }
      const txt = await res.text().catch(() => '');
      const err = new Error(`HTTP ${res.status} - ${txt.slice(0, 400)}`);
      err.status = res.status;
      throw err;
    } catch (e) {
      clearTimeout(t);
      lastErr = e;
      if (i < retries) {
        await new Promise(r => setTimeout(r, 200 * (i + 1) ** 2));
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr || new Error('fetchWithRetry unknown error');
}

/* ───────────── MAXI: login ───────────── */
async function maxiLogin({ email, pass, codcli }) {
  const res = await fetchWithRetry(`${BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ email, pass, cod_cli: String(codcli) })
  });
  const d = await res.json().catch(() => ({}));
  const ok = d?.resultCode === 'SUCCESS' && d?.content?.tokenAccess;
  if (!ok) {
    const msg = d?.resultDescription || `login_failed_${res.status}`;
    const err = new Error(msg); err.status = 502; throw err;
  }
  return d.content.tokenAccess;
}

/* ───────────── MAXI: traer ventas por rango (normalizador flexible) ───────────── */
async function maxiFetchSalesRange({ token, codcli, from, to }) {
  const makers = [
    (b)=>{ const u=new URL(`${b}/estadisticas/ventas/detalle`);           u.searchParams.set('cod_cli',codcli); u.searchParams.set('fechaInicio',from); u.searchParams.set('fechaFin',to); return u.toString(); },
    (b)=>{ const u=new URL(`${b}/estadisticas/ventas`);                   u.searchParams.set('cod_cli',codcli); u.searchParams.set('fechaInicio',from); u.searchParams.set('fechaFin',to); return u.toString(); },
    (b)=>{ const u=new URL(`${b}/ventas`);                                u.searchParams.set('cod_cli',codcli); u.searchParams.set('desde',from);        u.searchParams.set('hasta',to);     return u.toString(); },
    (b)=>{ const u=new URL(`${b}/estadisticas/ventasarticulos`);          u.searchParams.set('cod_cli',codcli); u.searchParams.set('fechaInicio',from); u.searchParams.set('fechaFin',to); return u.toString(); },
    (b)=>{ const u=new URL(`${b}/estadisticas/ventasarticulos/detalle`);  u.searchParams.set('cod_cli',codcli); u.searchParams.set('fechaInicio',from); u.searchParams.set('fechaFin',to); return u.toString(); },
    (b)=>{ const u=new URL(`${b}/estadisticas/ventas_por_articulo`);      u.searchParams.set('cod_cli',codcli); u.searchParams.set('fechaInicio',from); u.searchParams.set('fechaFin',to); return u.toString(); },
    (b)=>{ const u=new URL(`${b}/estadisticas/ventasporarticulo`);        u.searchParams.set('cod_cli',codcli); u.searchParams.set('fechaInicio',from); u.searchParams.set('fechaFin',to); return u.toString(); },
  ];

  const tryNormalize = (json) => {
    const arrays = [
      json?.content?.detalle,
      json?.content?.items,
      json?.content?.ventas,
      json?.detalle,
      json?.ventas,
      json?.items,
      Array.isArray(json?.content) ? json.content : null,
      Array.isArray(json) ? json : null,
    ].filter(Array.isArray);
    const rows = arrays[0] || [];
    const nnum = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
    const mapped = rows.map((o = {}) => {
      const id = Number(o.articulo_id ?? o.idArticulo ?? o.codart ?? o.codigo ?? o.codigoArticulo ?? o.id);
      const fechaRaw = o.day ?? o.fecha ?? o.fechaVenta ?? o.fecha_venta ?? o.dia ?? o.fechaEmision;
      const day = String(fechaRaw || '').slice(0, 10);
      const qty = nnum(o.qty ?? o.cantidad ?? o.cant ?? o.unidades ?? o.cantidadVendida);
      const amount = nnum(o.amount ?? o.importe ?? o.total ?? o.monto ?? o.importeTotal);
      if (!Number.isFinite(id) || !day) return null;
      return { id, day, qty, amount };
    }).filter(Boolean);
    return mapped;
  };

  let lastErr;
  for (const mk of makers) {
    const url = mk(BASE);
    try {
      const res = await fetchWithRetry(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
      const txt = await res.text();
      let json = null;
      try { json = JSON.parse(txt); } catch { /* podría venir CSV/HTML => descartamos */ }

      // Si Maxi devolvió un NOT_FOUND / error, seguimos probando
      if (!res.ok || (json && json.resultCode && json.resultCode !== 'SUCCESS')) {
        continue;
      }

      const lines = json ? tryNormalize(json) : [];
      if (lines.length > 0) return lines;

      // si respondió 200 pero sin líneas, seguimos probando alternativas
    } catch (e) {
      lastErr = e;
      continue;
    }
  }
  throw new Error('maxi_sales_fetch_failed');
}

/* ───────────── UPSERT ventas diarias (qty + amount) ───────────── */
async function upsertSalesDaily({ client, businessId, items }) {
  if (!items?.length) return { upserted: 0, updated: 0 };

  const CHUNK = 1000;
  let upserted = 0;
  let updated = 0;

  for (let i = 0; i < items.length; i += CHUNK) {
    const slice = items.slice(i, i + CHUNK);

    const values = [];
    const params = [];
    let p = 1;

    for (const it of slice) {
      const articuloId = Number(it.id);
      const day = String(it.day).slice(0, 10);
      const qty = Number(it.qty) || 0;
      const amount = Number(it.amount) || 0;
      if (!Number.isFinite(articuloId) || !day) continue;

      values.push(`($${p++},$${p++}::date,$${p++},$${p++},$${p++},NOW())`);
      params.push(businessId, day, articuloId, qty, amount);
    }
    if (!values.length) continue;

    const sql = `
      INSERT INTO public.maxi_sales_daily (business_id, day, articulo_id, qty, amount, updated_at)
      VALUES ${values.join(',')}
      ON CONFLICT (business_id, day, articulo_id)
      DO UPDATE SET
        qty        = EXCLUDED.qty,
        amount     = EXCLUDED.amount,
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
  const secret = mx.pass_enc ?? mx.password_enc ?? mx.password ?? mx.pass ?? null;
  const pass = decryptSecretCompat(secret);
  if (!email || !pass || !codcli) { const err = new Error('maxi_not_configured'); err.status = 400; throw err; }
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

exports.syncSalesForBusiness = async (biz, { mode = 'auto', from, to, dryrun = false } = {}) => {
  if (!biz?.id) { const e = new Error('no_active_business'); e.status = 400; throw e; }

  // rango por defecto: últimos 7 días hasta AYER
  const today = new Date();
  const defTo   = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 1));
  const defFrom = addDays(defTo, -6);

  const fDate = parseDate(from, defFrom);
  const tDate = parseDate(to,   defTo);
  const { from: clampFrom, to: clampTo } = clampToYesterday(fDate, tDate);
  const F = ymd(clampFrom);
  const T = ymd(clampTo);

  const client = await pool.connect();
  try {
    const { email, pass, codcli } = loadMaxiCredsFromBiz(biz);
    const token = await maxiLogin({ email, pass, codcli });

    const rows = await maxiFetchSalesRange({ token, codcli, from: F, to: T });

    if (dryrun) return { from: F, to: T, upserted: 0, updated: 0, preview: rows.slice(0, 5) };

    await client.query('BEGIN');

    // 1) Upsert diario crudo (maxi_sales_daily)
    const { upserted, updated } = await upsertSalesDaily({
      client,
      businessId: biz.id,
      items: rows
    });

    // 2) Conciliar mapeos por SKU y nombre (si usás app_sales/app_sales_items)
    //    Si todavía NO cargás ventas por factura/líneas, este paso no afectará nada (no rompe).
    await reconcileSalesMappings(client, biz.id, { from: F, to: T }).catch(() => {});

    // 3) Regenerar agregados para el rango [F..T]
    // 3.a) sales_daily (total y tx_count) desde maxi_sales_daily
    await client.query(`DELETE FROM sales_daily WHERE business_id=$1 AND day BETWEEN $2::date AND $3::date`, [biz.id, F, T]);
    await client.query(`
      INSERT INTO sales_daily (business_id, day, total, tx_count)
      SELECT business_id,
             day,
             SUM(amount) AS total,
             COUNT(*)    AS tx_count
      FROM public.maxi_sales_daily
      WHERE business_id=$1
        AND day BETWEEN $2::date AND $3::date
      GROUP BY business_id, day
    `, [biz.id, F, T]);

    // 3.b) sales_daily_items por artículo (si existen líneas en app_sales_items mapeadas)
    await client.query(`DELETE FROM sales_daily_items WHERE business_id=$1 AND day BETWEEN $2::date AND $3::date`, [biz.id, F, T]);
    await client.query(`
      INSERT INTO sales_daily_items (business_id, day, article_id, qty, amount)
      SELECT
        s.business_id,
        (s.occurred_at AT TIME ZONE 'UTC')::date AS day,
        si.article_id,
        SUM(si.qty)    AS qty,
        SUM(si.amount) AS amount
      FROM app_sales_items si
      JOIN app_sales s ON s.id = si.sale_id
      WHERE s.business_id = $1
        AND (s.occurred_at AT TIME ZONE 'UTC')::date BETWEEN $2::date AND $3::date
        AND si.article_id IS NOT NULL
      GROUP BY s.business_id, day, si.article_id
    `, [biz.id, F, T]);

    await client.query('COMMIT');
    return { from: F, to: T, upserted, updated };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('syncSalesForBusiness error:', e?.stack || e);
    const err = new Error(e?.message || 'sales_sync_failed'); err.status = e.status || 500; throw err;
  } finally {
    client.release();
  }
};

/* ───────────── Handler Express listo para rutas admin ─────────────
   Útil si en admin.routes.js querés:
   r.post('/businesses/:id/sync-sales', allowAdminAsBusiness, salesSyncController.adminSyncSales)
--------------------------------------------------------------------*/
exports.adminSyncSales = async (req, res) => {
  try {
    const biz = req.business; // seteado por allowAdminAsBusiness / requireBusinessAccess
    const { mode = 'auto', from, to, dryrun } = { ...req.query, ...req.body };
    const out = await exports.syncSalesForBusiness(biz, { mode, from, to, dryrun: String(dryrun) === '1' || dryrun === true });
    return res.json({ ok: true, sales: out });
  } catch (e) {
    const status = e.status || 500;
    return res.status(status).json({ error: status === 401 ? 'unauthorized' : 'internal', message: e.message || 'sales_sync_failed' });
  }
};

exports.maxiSalesProbe = async (req, res) => {
  try {
    const biz = req.business;
    const { email, pass, codcli } = loadMaxiCredsFromBiz(biz);
    const token = await maxiLogin({ email, pass, codcli });

    const from = String(req.query.from || '').slice(0, 10);
    const to   = String(req.query.to   || '').slice(0, 10);

    const makers = [
      (b)=>{ const u=new URL(`${b}/estadisticas/ventas/detalle`);      u.searchParams.set('cod_cli',codcli); u.searchParams.set('fechaInicio',from); u.searchParams.set('fechaFin',to); return u.toString(); },
      (b)=>{ const u=new URL(`${b}/estadisticas/ventas`);              u.searchParams.set('cod_cli',codcli); u.searchParams.set('fechaInicio',from); u.searchParams.set('fechaFin',to); return u.toString(); },
      (b)=>{ const u=new URL(`${b}/ventas`);                           u.searchParams.set('cod_cli',codcli); u.searchParams.set('desde',from);        u.searchParams.set('hasta',to);     return u.toString(); },
      (b)=>{ const u=new URL(`${b}/estadisticas/ventasarticulos`);     u.searchParams.set('cod_cli',codcli); u.searchParams.set('fechaInicio',from); u.searchParams.set('fechaFin',to); return u.toString(); },
      (b)=>{ const u=new URL(`${b}/estadisticas/ventasarticulos/detalle`); u.searchParams.set('cod_cli',codcli); u.searchParams.set('fechaInicio',from); u.searchParams.set('fechaFin',to); return u.toString(); },
      (b)=>{ const u=new URL(`${b}/estadisticas/ventas_por_articulo`); u.searchParams.set('cod_cli',codcli); u.searchParams.set('fechaInicio',from); u.searchParams.set('fechaFin',to); return u.toString(); },
      (b)=>{ const u=new URL(`${b}/estadisticas/ventasporarticulo`);   u.searchParams.set('cod_cli',codcli); u.searchParams.set('fechaInicio',from); u.searchParams.set('fechaFin',to); return u.toString(); },
    ];

    const tried = [];
    const hits = [];

    for (const mk of makers) {
      const url = mk(BASE);
      try {
        const r = await fetchNative(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }});
        const text = await r.text();
        let json = null;
        try { json = JSON.parse(text); } catch {}
        const arrays =
          (json && [
            json?.content?.detalle,
            json?.content?.items,
            json?.content?.ventas,
            json?.detalle,
            json?.ventas,
            json?.items,
            Array.isArray(json?.content) ? json.content : null,
            Array.isArray(json) ? json : null,
          ].filter(Array.isArray)) || [];

        const rows = arrays[0] || [];
        tried.push({ url, status: r.status, resultCode: json?.resultCode, keys: json ? Object.keys(json) : null, contentKeys: json?.content ? Object.keys(json.content) : null, rows: rows.length, preview: text.slice(0, 400) });

        if (r.ok && rows.length > 0) {
          hits.push({ url, rows: rows.length });
        }
      } catch (e) {
        tried.push({ url, error: String(e?.message || e) });
      }
    }

    return res.json({ ok: true, hits, tried });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};
