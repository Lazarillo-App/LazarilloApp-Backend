/* eslint-disable no-console */
// controllers/syncController.js
const pool = require('../config/db');
const { decryptSecretCompat } = require('../utils/cryptoField');

/* Fetch nativo (Node ≥18) con fallback */
const fetchNative =
  (typeof globalThis.fetch === 'function')
    ? ((...args) => globalThis.fetch(...args))
    : require('node-fetch');

/* Config Maxi via ENV */
const BASE = (process.env.MAXI_BASE_URL || 'https://api-mconn.maxisistemas.com.ar').replace(/\/+$/, '');
const FETCH_TIMEOUT_MS = Number(process.env.MAXI_FETCH_TIMEOUT_MS || 30000);
const FETCH_RETRIES    = Number(process.env.MAXI_FETCH_RETRIES || 2);
const ITEMS_PATH       = (process.env.MAXI_ITEMS_PATH || '/estadisticas/menu').replace(/\/+$/, '');

function parseDate(zd, fallback) {
  if (zd == null || zd === '') return new Date(fallback);
  if (zd instanceof Date) return Number.isNaN(+zd) ? new Date(fallback) : zd;
  if (typeof zd === 'number') {
    const d = new Date(zd);
    return Number.isNaN(+d) ? new Date(fallback) : d;
  }
  const d = new Date(String(zd));
  return Number.isNaN(+d) ? new Date(fallback) : d;
}
function ymd(d) {
  if (!(d instanceof Date) || Number.isNaN(+d)) d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function addDays(d, n) { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; }

async function fetchWithRetry(url, options = {}, { retries = FETCH_RETRIES, timeout = FETCH_TIMEOUT_MS } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort('timeout'), timeout);
    try {
      const res = await fetchNative(url, { ...options, signal: ctrl.signal });
      clearTimeout(t);
      if (res.ok) return res;
      if ([429, 500, 502, 503, 504].includes(res.status) && attempt < retries) {
        const delay = 200 * (attempt + 1) ** 2;
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      const txt = await res.text().catch(() => '');
      const err = new Error(`HTTP ${res.status} - ${txt.slice(0, 200)}`);
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

/* MAXI: login + fetch menú/ítems */
async function maxiLogin({ email, pass, codcli }) {
  const url = `${BASE}/login`;
  const body = { email, pass, cod_cli: String(codcli) };
  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  const ok = data?.resultCode === 'SUCCESS' && data?.content?.tokenAccess;
  if (!ok) {
    const msg = data?.resultDescription || `login_failed_${res.status}`;
    const err = new Error(msg); err.status = 502; throw err;
  }
  return data.content.tokenAccess;
}
async function maxiFetchItems({ token, codcli }) {
  const u = new URL(`${BASE}${ITEMS_PATH}`);
  u.searchParams.set('cod_cli', String(codcli));
  u.searchParams.set('codcli',  String(codcli));
  const res = await fetchWithRetry(u.toString(), { headers: { Authorization: `Bearer ${token}` } });
  const d = await res.json().catch(() => ({}));
  const candidates = [
    d?.content?.articulos,
    d?.content?.items,
    d?.items,
    d?.articulos,
    d?.content?.content?.articulos,
    Array.isArray(d) ? d : null,
  ];
  return candidates.find(Array.isArray) || [];
}

/* UPSERT en public.maxi_articles */
async function upsertArticles({ client, businessId, items }) {
  if (!items || !items.length) return 0;
  const CHUNK = 500;
  let total = 0;

  for (let i = 0; i < items.length; i += CHUNK) {
    const slice = items.slice(i, i + CHUNK);
    const values = [];
    const params = [];
    let p = 1;

    for (const it of slice) {
      const id = Number(it.id ?? it.codart ?? it.codigo ?? it.codigoArticulo ?? it.cod_art ?? it.articulo_id);
      if (!Number.isFinite(id)) continue;

      const nombre = (String(it.nombre ?? it.descripcion ?? it.descripcionl ?? it.nombre_art ?? '').slice(0, 200) || null);
      const categoria = (String(it.categoria ?? it.rubro ?? '').trim() || 'Sin categoría');
      const subrubro  = (String(it.subrubro ?? it.sub_rubro ?? '').trim() || 'Sin subrubro');
      const precio    = Number(it.precio ?? it.precioVenta ?? it.importe ?? it.precio_sugerido ?? 0) || 0;
      const costo     = Number(it.costo  ?? it.costoPromedio ?? it.costo_ultima_compra ?? 0) || 0;

      values.push(`($${p},$${p+1},$${p+2},$${p+3},$${p+4},$${p+5},$${p+6}::jsonb,NOW())`);
      params.push(businessId, id, nombre, categoria, subrubro, precio, costo, JSON.stringify(it.raw ?? it._raw ?? it));
      p += 7;
    }

    if (!values.length) continue;

    const sql = `
      INSERT INTO public.maxi_articles
        (business_id, articulo_id, nombre, categoria, subrubro, precio, costo, raw, updated_at)
      VALUES ${values.join(',')}
      ON CONFLICT (business_id, articulo_id) DO UPDATE SET
        nombre    = EXCLUDED.nombre,
        categoria = EXCLUDED.categoria,
        subrubro  = EXCLUDED.subrubro,
        precio    = EXCLUDED.precio,
        costo     = EXCLUDED.costo,
        raw       = EXCLUDED.raw,
        updated_at= NOW()
    `;
    await client.query(sql, params);
    total += slice.length;
  }
  return total;
}

/* Credenciales Maxi desde biz.props.maxi */
function loadMaxiCredsFromBiz(biz) {
  const props = biz?.props || {};
  const mx = props.maxi || props.maxi_credentials || {};
  const email = mx.email || mx.user || null;
  const codcli = mx.codcli || mx.codigo || null;

  const secret =
    mx.pass_enc ??
    mx.password_enc ??
    mx.password ??
    mx.pass ??
    null;

  const pass = decryptSecretCompat(secret);
  if (!email || !pass || !codcli) {
    const err = new Error('missing_maxi_credentials'); err.status = 400; throw err;
  }
  return { email, pass, codcli };
}

/* ─────────── Endpoints: catálogo ─────────── */

// GET /api/businesses/:id/articles
exports.listArticlesFromDB = async (req, res) => {
  const biz = req.business;
  if (!biz?.id) return res.status(400).json({ error: 'no_active_business' });
  try {
    const { rows } = await pool.query(
      `SELECT articulo_id, nombre, categoria, subrubro, precio, costo
         FROM public.maxi_articles
        WHERE business_id = $1
        ORDER BY nombre ASC`,
      [biz.id],
    );
    res.json({ ok: true, items: rows, count: rows.length });
  } catch (e) {
    console.error('listArticlesFromDB error:', e);
    res.status(500).json({ error: 'internal', detail: e.message });
  }
};

// GET /api/businesses/:id/articles/tree  (subrubro > categoría > artículos)
exports.listArticlesTreeFromDB = async (req, res) => {
  const biz = req.business;
  if (!biz?.id) return res.status(400).json({ error: 'no_active_business' });
  try {
    const { rows } = await pool.query(
      `SELECT articulo_id, nombre, categoria, subrubro, precio
         FROM public.maxi_articles
        WHERE business_id = $1
        ORDER BY subrubro, categoria, nombre`,
      [biz.id],
    );

    const bySub = new Map();
    for (const r of rows) {
      const sub = r.subrubro || 'Sin subrubro';
      const cat = r.categoria || 'Sin categoría';
      if (!bySub.has(sub)) bySub.set(sub, new Map());
      const byCat = bySub.get(sub);
      if (!byCat.has(cat)) byCat.set(cat, []);
      byCat.get(cat).push({ id: r.articulo_id, nombre: r.nombre, precio: r.precio ?? null });
    }

    const tree = Array.from(bySub.entries()).map(([subrubro, byCat]) => ({
      subrubro,
      categorias: Array.from(byCat.entries()).map(([categoria, articulos]) => ({ categoria, articulos })),
    }));

    const categoriasCount = tree.reduce((a, s) => a + (s.categorias?.length || 0), 0);
    const articulosCount  = tree.reduce((a, s) => a + s.categorias.reduce((x, c) => x + (c.articulos?.length || 0), 0), 0);

    res.json({ ok: true, resumen: { subrubros: tree.length, categorias: categoriasCount, articulos: articulosCount }, tree });
  } catch (e) {
    console.error('listArticlesTreeFromDB error:', e);
    res.status(500).json({ error: 'internal', detail: e.message });
  }
};

// POST /api/businesses/:id/sync  (catálogo)
exports.syncNow = async (req, res) => {
  const biz = req.business;
  if (!biz?.id) return res.status(400).json({ error: 'no_active_business' });

  const scope = String(req.body?.scope || 'articles').toLowerCase();
  const now = new Date();
  const defFrom = addDays(now, -30);
  const from = parseDate(req.body?.from, defFrom);
  const to   = parseDate(req.body?.to, now);

  const client = await pool.connect();
  try {
    const { email, pass, codcli } = loadMaxiCredsFromBiz(biz);
    const token = await maxiLogin({ email, pass, codcli });

    let upserted = 0;
    let mapped = 0; // reservado a futuro

    if (scope === 'articles' || scope === 'all') {
      const items = await maxiFetchItems({ token, codcli });
      await client.query('BEGIN');
      upserted = await upsertArticles({ client, businessId: biz.id, items });
      await client.query('COMMIT');
    }

    return res.json({ ok: true, business_id: biz.id, scope, from: ymd(from), to: ymd(to), upserted, mapped });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('syncNow error:', e);
    const status = e.status || (String(e.message || '').includes('401') ? 401 : 500);
    return res.status(status).json({ error: 'sync_failed', detail: e.message || 'sync_failed' });
  } finally {
    client.release();
  }
};

/* Legacy (410) */
exports.salesSummaryFromDB = async (_req, res) => {
  res.status(410).json({ error: 'gone', detail: 'Usá /api/ventas/summary con X-Business-Id.' });
};
exports.salesSeriesFromDB = async (_req, res) => {
  res.status(410).json({ error: 'gone', detail: 'Usá /api/ventas/by-article con X-Business-Id.' });
};
