// controllers/syncController.js
/* eslint-disable no-console */
const pool = require('../config/db');
const { decryptSecretCompat } = require('../utils/cryptoField');

const fetchNative = global.fetch || require('node-fetch');

const BASE = (process.env.MAXI_BASE_URL || 'https://api-mconn.maxisistemas.com.ar').replace(/\/$/, '');
const FETCH_TIMEOUT_MS = Number(process.env.MAXI_FETCH_TIMEOUT_MS || 30000);
const FETCH_RETRIES = Number(process.env.MAXI_FETCH_RETRIES || 2);

/* ======================= Utils ======================= */
function simpleHash(str = '') {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return String(h >>> 0);
}

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

function addDays(d, n) {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}

/* ===== Fetch con timeout + reintentos (429/5xx) ===== */
async function fetchWithRetry(url, options = {}, { retries = FETCH_RETRIES, timeout = FETCH_TIMEOUT_MS } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort('timeout'), timeout);
    try {
      const res = await fetchNative(url, { ...options, signal: ctrl.signal });
      clearTimeout(t);
      if (res.ok) return res;

      // Reintentar en 429/5xx
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

/* ======================= MAXI API ======================= */
// NOTA: si tus rutas reales difieren, ajustá estas dos funciones solamente.
async function maxiLogin({ email, password }) {
  const url = `${BASE}/login`;
  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  const data = await res.json().catch(() => ({}));
  const token = data?.token || data?.access_token || data?.jwt || null;
  if (!token) {
    const msg = data?.error || 'login_failed';
    const err = new Error(msg);
    err.status = 401;
    throw err;
  }
  return token;
}

// Descarga catálogo de artículos. Cambiá path/qs si tu API usa otros nombres.
async function maxiFetchItems({ token, codcli }) {
  const url = `${BASE}/items?codcli=${encodeURIComponent(codcli)}`;
  const res = await fetchWithRetry(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json().catch(() => ({}));
  // Normalizamos a array
  const items = Array.isArray(data?.items) ? data.items : (Array.isArray(data) ? data : []);
  return items;
}

/* ========== Upsert en public.maxi_articles (chunked) ========== */
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
      const id = Number(it.id ?? it.codart ?? it.codigo ?? it.codigoArticulo);
      if (!Number.isFinite(id)) continue;

      const nombre = (String(it.nombre ?? it.descripcion ?? it.descripcionl ?? '').slice(0, 200) || null);
      const categoria = (String(it.categoria ?? '').trim() || 'Sin categoría');
      const subrubro = (String(it.subrubro ?? '').trim() || 'Sin subrubro');
      const precio = Number(it.precio ?? it.precioVenta ?? it.importe ?? 0) || 0;
      const costo  = Number(it.costo  ?? it.costoPromedio ?? 0) || 0;

      // 8 columnas -> $p ... $p+7
      values.push(`($${p},$${p+1},$${p+2},$${p+3},$${p+4},$${p+5},$${p+6},$${p+7}::jsonb,NOW())`);
      params.push(
        businessId, id, nombre, categoria, subrubro, precio, costo,
        JSON.stringify(it.raw ?? it._raw ?? it)
      );
      p += 8;
    }

    if (!values.length) continue;

    const sql = `
      INSERT INTO public.maxi_articles
        (business_id, articulo_id, nombre, categoria, subrubro, precio, costo, raw, updated_at)
      VALUES ${values.join(',')}
      ON CONFLICT (business_id, articulo_id)
      DO UPDATE SET
        nombre     = EXCLUDED.nombre,
        categoria  = EXCLUDED.categoria,
        subrubro   = EXCLUDED.subrubro,
        precio     = EXCLUDED.precio,
        costo      = EXCLUDED.costo,
        raw        = EXCLUDED.raw,
        updated_at = NOW()
    `;
    await client.query(sql, params);
    total += slice.length;
  }

  return total;
}

/* =================== Helpers credenciales MAXI =================== */
function loadMaxiCredsFromBiz(biz) {
  // Convenciones: guardamos en biz.props.maxi ó biz.props.maxi_credentials
  const props = biz?.props || {};
  const mx = props.maxi || props.maxi_credentials || {};
  const email = mx.email || mx.user || null;
  const codcli = mx.codcli || mx.codigo || null;

  // Puede venir guardado cifrado como { password_enc } ó { password }
  const passwordRaw = mx.password_enc || mx.password || null;
  const password = decryptSecretCompat(passwordRaw);

  if (!email || !password || !codcli) {
    const err = new Error('missing_maxi_credentials');
    err.status = 400;
    throw err;
  }
  return { email, password, codcli };
}

/* ======================= Endpoints ======================= */

// GET /:id/articles  (lista plana)
exports.listArticlesFromDB = async (req, res) => {
  const biz = req.business;
  if (!biz?.id) return res.status(400).json({ error: 'no_active_business' });

  try {
    const { rows } = await pool.query(
      `SELECT articulo_id, nombre, categoria, subrubro, precio, costo
         FROM public.maxi_articles
        WHERE business_id = $1
        ORDER BY nombre ASC`,
      [biz.id]
    );
    res.json({ ok: true, items: rows, count: rows.length });
  } catch (e) {
    console.error('listArticlesFromDB error:', e);
    res.status(500).json({ error: 'internal', detail: e.message });
  }
};

// GET /:id/articles/tree  (subrubro > categoría > artículos)
exports.listArticlesTreeFromDB = async (req, res) => {
  const biz = req.business;
  if (!biz?.id) return res.status(400).json({ error: 'no_active_business' });

  try {
    const { rows } = await pool.query(
      `SELECT articulo_id, nombre, categoria, subrubro, precio
         FROM public.maxi_articles
        WHERE business_id = $1
        ORDER BY subrubro, categoria, nombre`,
      [biz.id]
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
      categorias: Array.from(byCat.entries()).map(([categoria, articulos]) => ({ categoria, articulos }))
    }));

    const categoriasCount = tree.reduce((a, s) => a + (s.categorias?.length || 0), 0);
    const articulosCount = tree.reduce(
      (a, s) => a + s.categorias.reduce((x, c) => x + (c.articulos?.length || 0), 0),
      0
    );

    res.json({
      ok: true,
      resumen: {
        subrubros: tree.length,
        categorias: categoriasCount,
        articulos: articulosCount,
      },
      tree
    });
  } catch (e) {
    console.error('listArticlesTreeFromDB error:', e);
    res.status(500).json({ error: 'internal', detail: e.message });
  }
};

// POST /:id/sync
// Body:
//   - scope: 'articles' | 'all' (default 'articles')
//   - from / to (opcional) SI tu fetch de items acepta fechas; si no, se ignoran
exports.syncNow = async (req, res) => {
  const biz = req.business;
  if (!biz?.id) return res.status(400).json({ error: 'no_active_business' });

  const scope = (req.body?.scope || 'articles').toLowerCase();

  const now = new Date();
  const defFrom = addDays(now, -30); // por si quisieras fechas
  const from = parseDate(req.body?.from, defFrom);
  const to   = parseDate(req.body?.to, now);

  const client = await pool.connect();
  try {
    // Tomar credenciales MAXI
    const { email, password, codcli } = loadMaxiCredsFromBiz(biz);

    // Login + token
    const token = await maxiLogin({ email, password });

    // Por ahora solo sincronizamos artículos (catálogo)
    let upserted = 0;
    let mapped = 0; // si tenés lógica de mapeo extra, setear acá

    if (scope === 'articles' || scope === 'all') {
      const items = await maxiFetchItems({ token, codcli });
      await client.query('BEGIN');
      upserted = await upsertArticles({ client, businessId: biz.id, items });
      await client.query('COMMIT');
    }

    return res.json({
      ok: true,
      business_id: biz.id,
      scope,
      from: ymd(from),
      to: ymd(to),
      upserted,
      mapped
    });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('syncNow error:', e);
    const status = e.status || (String(e.message || '').includes('401') ? 401 : 500);
    const detail = e.message || 'sync_failed';
    return res.status(status).json({ error: 'sync_failed', detail });
  } finally {
    client.release();
  }
};

/* ===== Compat (legacy) — derivados a /api/ventas ===== */
exports.salesSummaryFromDB = async (_req, res) => {
  res.status(410).json({
    error: 'gone',
    detail: 'Este endpoint fue reemplazado por /api/ventas/summary (con X-Business-Id).'
  });
};

exports.salesSeriesFromDB = async (_req, res) => {
  res.status(410).json({
    error: 'gone',
    detail: 'Este endpoint fue reemplazado por /api/ventas/by-article (con X-Business-Id).'
  });
};
