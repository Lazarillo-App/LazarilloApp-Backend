/* eslint-disable no-console */
const pool = require('../config/db');
const { decryptSecretCompat } = require('../utils/cryptoField');

// fetch nativo (Node 18+) o fallback a node-fetch
const fetchNative =
  (typeof globalThis.fetch === 'function')
    ? ((...args) => globalThis.fetch(...args))
    : require('node-fetch');

const BASE = (process.env.MAXI_BASE_URL || 'https://api-mconn.maxisistemas.com.ar').replace(/\/+$/, '');
const FETCH_TIMEOUT_MS = Number(process.env.MAXI_FETCH_TIMEOUT_MS || 30000);
const FETCH_RETRIES    = Number(process.env.MAXI_FETCH_RETRIES || 2);

/* ======================= Utils básicos ======================= */
function simpleHash(str = '') {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return String(h >>> 0);
}
const norm = s => String(s ?? '').trim();
const orSinCategoria = s => (norm(s) || 'Sin categoría');
const orSinSubrubro  = s => (norm(s) || 'Sin subrubro');

function parseDate(zd, fallback) {
  if (zd == null || zd === '') return new Date(fallback);
  if (zd instanceof Date)     return Number.isNaN(+zd) ? new Date(fallback) : zd;
  if (typeof zd === 'number') { const d = new Date(zd); return Number.isNaN(+d) ? new Date(fallback) : d; }
  const d = new Date(String(zd)); return Number.isNaN(+d) ? new Date(fallback) : d;
}
function ymd(d) {
  if (!(d instanceof Date) || Number.isNaN(+d)) d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function addDays(d, n) { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; }

/* ========== Fetch con timeout + reintentos (429/5xx) ========== */
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
        await new Promise(r => setTimeout(r, 200 * (attempt + 1) ** 2));
        continue;
      }
      const txt = await res.text().catch(() => '');
      const err = new Error(`HTTP ${res.status} - ${txt.slice(0,200)}`); err.status = res.status;
      throw err;
    } catch (e) {
      clearTimeout(t); lastErr = e;
      if (attempt < retries) { await new Promise(r => setTimeout(r, 200 * (attempt + 1) ** 2)); continue; }
      throw lastErr;
    }
  }
  throw lastErr || new Error('fetchWithRetry unknown error');
}

/* =================== MAXI: login y artículos =================== */
async function maxiLogin({ email, password, codcli }) {
  const res = await fetchWithRetry(`${BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept':'application/json' },
    body: JSON.stringify({ email, pass: password, cod_cli: String(codcli) })
  });
  const j = await res.json().catch(() => ({}));
  if (j?.resultCode !== 'SUCCESS' || !j?.content?.tokenAccess) {
    const id = j?.resultId || 'login_failed';
    throw new Error(`maxi_login_failed_${id}`);
  }
  return j.content.tokenAccess;
}

/**
 * Trae menú extendido (menuweb/menuextendido) y flatea a artículos con SWAP:
 *   app.categoria = subrubro Maxi
 *   app.subrubro  = rubro Maxi
 */
async function fetchMaxiArticles({ token, from, to }) {
  const u = new URL(`${BASE}/menuweb/menuextendido`);
  if (from) u.searchParams.set('fechaInicio', from);
  if (to)   u.searchParams.set('fechaFin', to);

  const res = await fetchWithRetry(u.toString(), { headers: { Authorization: `Bearer ${token}` } });
  const j = await res.json().catch(() => ({}));
  if (j?.resultCode !== 'SUCCESS') throw new Error('maxi_articles_fetch_failed');

  const root = Array.isArray(j?.content)
    ? j.content
    : Array.isArray(j?.menu?.content)
    ? j.menu.content
    : Array.isArray(j?.data?.content)
    ? j.data.content
    : [];

  const items = [];
  const seen = new Set();

  const isArticle = (o = {}) => {
    const hasId   = ['id','idArticulo','codart','codigo','codigoArticulo'].some(k => k in o);
    const hasInfo = ['descripcion','descripcionl','nombre','precio','precioVenta','importe'].some(k => k in o);
    return hasId && hasInfo;
  };
  const num     = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
  const getName = (o) => String(o?.descripcion ?? o?.descripcionl ?? o?.nombre ?? '').trim();

  const pushArt = (o, { rubroNombre, subrubroNombre }) => {
    const id = num(o.id ?? o.idArticulo ?? o.codart ?? o.codigo ?? o.codigoArticulo, NaN);
    if (!Number.isFinite(id) || seen.has(id)) return;
    seen.add(id);
    items.push({
      id,
      nombre: getName(o),
      categoria: orSinCategoria(subrubroNombre), // SWAP
      subrubro : orSinSubrubro(rubroNombre),     // SWAP
      precio: num(o.precio ?? o.precioVenta ?? o.importe, 0),
      costo : num(o.costo  ?? o.costoPromedio, 0),
      raw: o,
    });
  };

  for (const rubro of root) {
    const rubroNombre =
      String(
        rubro?.nombre ??
        rubro?.rubroNombre ??
        rubro?.rubro?.descripcion ??
        rubro?.rubro ??
        ''
      ).trim() || 'Sin subrubro'; // rubro Maxi → subrubro app

    const artsRubro = Array.isArray(rubro?.articulos) ? rubro.articulos : [];
    for (const a of artsRubro) if (isArticle(a)) pushArt(a, { rubroNombre, subrubroNombre: '' });

    const subrubros = Array.isArray(rubro?.subrubros) ? rubro.subrubros : [];
    for (const s of subrubros) {
      const subrubroNombre =
        String(s?.nombre ?? s?.nombreSubRubro ?? s?.subRubro?.descripcion ?? s?.subrubro ?? '').trim() || 'Sin subrubro';

      const arts = Array.isArray(s?.articulos) ? s.articulos : [];
      for (const a of arts) if (isArticle(a)) pushArt(a, { rubroNombre, subrubroNombre });

      const subs2 = Array.isArray(s?.subrubros) ? s.subrubros : [];
      for (const s2 of subs2) {
        const subSubNombre =
          String(s2?.nombre ?? s2?.nombreSubRubro ?? s2?.subRubro?.descripcion ?? s2?.subrubro ?? '').trim()
          || subrubroNombre;
        const arts2 = Array.isArray(s2?.articulos) ? s2.articulos : [];
        for (const a of arts2) if (isArticle(a)) pushArt(a, { rubroNombre, subrubroNombre: subSubNombre });
      }
    }
  }
  return { items, raw: root };
}

/* ========== Upsert en public.maxi_articles (chunked) ========== */
async function upsertArticles({ client, businessId, items }) {
  if (!items?.length) return 0;
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

      const nombre   = (String(it.nombre ?? it.descripcion ?? it.descripcionl ?? '').slice(0,200) || null);
      const categoria= orSinCategoria(it.categoria);
      const subrubro = orSinSubrubro(it.subrubro);
      const precio   = Number(it.precio ?? it.precioVenta ?? it.importe ?? 0) || 0;
      const costo    = Number(it.costo  ?? it.costoPromedio ?? 0) || 0;

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
        nombre   = EXCLUDED.nombre,
        categoria= EXCLUDED.categoria,
        subrubro = EXCLUDED.subrubro,
        precio   = EXCLUDED.precio,
        costo    = EXCLUDED.costo,
        raw      = EXCLUDED.raw,
        updated_at = NOW()
    `;
    await client.query(sql, params);
    total += slice.length;
  }
  return total;
}

/* ============================ Handlers ============================ */

/**
 * POST /businesses/:id/sync
 * body: { scope: 'articles' | 'all', from?, to? }
 */
exports.syncNow = async (req, res) => {
  const biz = req.business;
  if (!biz?.id) return res.status(400).json({ error: 'no_active_business' });

  const { scope = 'articles', from, to } = req.body || {};
  const today = new Date();
  const startOfMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const yesterday    = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 1));
  const f = ymd(parseDate(from, startOfMonth));
  const t = ymd(parseDate(to,   yesterday));

  const mx = (biz?.props || {}).maxi || (biz?.props || {}).maxi_credentials || {};
  const password = mx.pass_enc ? decryptSecretCompat(mx.pass_enc) : (mx.password || mx.pass || '');
  if (!(mx.email && password && mx.codcli)) {
    return res.status(400).json({ error: 'maxi_not_configured' });
  }

  const client = await pool.connect();
  try {
    const token = await maxiLogin({ email: mx.email, password, codcli: mx.codcli });

    let upserted = 0;
    let mapped   = 0;
    let cacheHash = null;

    if (scope === 'articles' || scope === 'all') {
      const { items, raw } = await fetchMaxiArticles({ token, from: f, to: t });

      const rawStr = JSON.stringify(raw ?? []);
      cacheHash = String(require('crypto').createHash('sha1').update(rawStr).digest('hex'));
      await pool.query(`
        INSERT INTO public.maxi_menu_cache (business_id, payload, hash, updated_at)
        VALUES ($1, $2::jsonb, $3, NOW())
        ON CONFLICT (business_id, hash) DO UPDATE SET updated_at = NOW()
      `, [biz.id, rawStr, cacheHash]);

      await client.query('BEGIN');
      upserted = await upsertArticles({ client, businessId: biz.id, items });

      const r = await client.query(`
        WITH src AS (
          SELECT business_id, articulo_id,
                 NULLIF(btrim(categoria),'') AS categoria,
                 NULLIF(btrim(subrubro),'')  AS subrubro
          FROM public.maxi_articles
          WHERE business_id = $1
        )
        INSERT INTO public.maxi_article_map (business_id, articulo_id, categoria, subrubro, updated_at)
        SELECT business_id,
               articulo_id,
               COALESCE(categoria,'[PENDIENTE]'),
               COALESCE(subrubro,'[PENDIENTE]'),
               NOW()
        FROM src
        ON CONFLICT (business_id, articulo_id) DO UPDATE
          SET categoria = EXCLUDED.categoria,
              subrubro  = EXCLUDED.subrubro,
              updated_at= NOW()
      `, [biz.id]);
      mapped = r.rowCount || 0;

      await client.query('COMMIT');
    }

    return res.json({ ok: true, business_id: biz.id, scope: 'articles', from: f, to: t, upserted, mapped, cacheHash });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    const msg = String(e?.message || '');
    if (msg.includes('maxi_login_failed') || e.status === 401 || msg.includes('401')) {
      return res.status(401).json({ error: 'unauthorized', detail: 'Maxi login failed/401' });
    }
    if (msg.includes('maxi_not_configured')) {
      return res.status(400).json({ error: 'maxi_not_configured' });
    }
    console.error('syncNow error:', e?.stack || e);
    return res.status(500).json({ error: 'internal', detail: msg });
  } finally {
    client.release();
  }
};

/**
 * GET /businesses/:id/articles (lista plana)
 */
exports.listArticlesFromDB = async (req, res) => {
  const biz = req.business;
  if (!biz?.id) return res.status(400).json({ error: 'no_active_business' });
  const { rows } = await pool.query(`
    SELECT articulo_id AS id, nombre, categoria, subrubro, precio, costo, raw
    FROM public.maxi_articles
    WHERE business_id = $1
    ORDER BY categoria, subrubro, nombre
  `, [biz.id]);
  res.json({ items: rows });
};

/**
 * GET /businesses/:id/articles/tree (subrubro > categoría > artículos)
 */
exports.listArticlesTreeFromDB = async (req, res) => {
  const biz = req.business;
  if (!biz?.id) return res.status(400).json({ error: 'no_active_business' });
  try {
    const { rows } = await pool.query(`
      SELECT articulo_id, nombre, categoria, subrubro, precio
      FROM public.maxi_articles
      WHERE business_id = $1
      ORDER BY subrubro, categoria, nombre
    `, [biz.id]);

    const bySub = new Map();
    for (const r of rows) {
      const sub = (r.subrubro && r.subrubro.trim()) || 'Sin subrubro';
      const cat = (r.categoria && r.categoria.trim()) || 'Sin categoría';
      if (!bySub.has(sub)) bySub.set(sub, new Map());
      const byCat = bySub.get(sub);
      if (!byCat.has(cat)) byCat.set(cat, []);
      byCat.get(cat).push({ id: r.articulo_id, nombre: r.nombre, precio: r.precio ?? null });
    }

    const tree = Array.from(bySub.entries()).map(([subrubro, byCat]) => ({
      subrubro,
      categorias: Array.from(byCat.entries()).map(([categoria, articulos]) => ({ categoria, articulos })),
    }));
    const resumen = {
      subrubros: tree.length,
      categorias: tree.reduce((a, s) => a + (s.categorias?.length || 0), 0),
      articulos: tree.reduce((a, s) => a + s.categorias.reduce((x, c) => x + (c.articulos?.length || 0), 0), 0),
    };
    res.json({ ok: true, resumen, tree });
  } catch (e) {
    console.error('listArticlesTreeFromDB error:', e);
    res.status(500).json({ error: 'internal', detail: e.message });
  }
};

/**
 * GET /businesses/:id/maxi-articles-proxy?from=YYYY-MM-DD&to=YYYY-MM-DD
 */
exports.maxiArticlesProxy = async (req, res) => {
  const biz = req.business;
  if (!biz?.id) return res.status(400).json({ error: 'no_active_business' });

  const today = new Date();
  const startOfMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const yesterday    = addDays(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())), -1);
  const from = ymd(parseDate(req.query.from, startOfMonth));
  const to   = ymd(parseDate(req.query.to,   yesterday));

  try {
    const mx = (biz?.props || {}).maxi || (biz?.props || {}).maxi_credentials || {};
    const password = mx.pass_enc ? decryptSecretCompat(mx.pass_enc) : (mx.password || mx.pass || '');
    if (!(mx.email && password && mx.codcli)) return res.status(400).json({ error: 'maxi_not_configured' });

    const token = await maxiLogin({ email: mx.email, password, codcli: mx.codcli });
    const { items } = await fetchMaxiArticles({ token, from, to });
    res.json({ from, to, items });
  } catch (e) {
    console.error('maxiArticlesProxy error:', e);
    res.status(500).json({ error: 'internal', detail: e.message });
  }
};

/* ===== Compat (legacy) — ventas lectura vieja ===== */
exports.salesSummaryFromDB = async (req, res, next) => {
  try {
    const bizId =
      Number(req.business?.id) ||
      Number(req.params.id) ||
      Number(req.query.businessId);

    if (!Number.isFinite(bizId)) {
      return res.status(400).json({ error: 'invalid_business_id' });
    }

    const from = String(req.query.from || '').slice(0, 10);
    const to   = String(req.query.to   || '').slice(0, 10);
    const limit = Number(req.query.limit || 1000) || 1000;

    if (!from || !to) {
      return res.status(400).json({
        error: 'from_to_required',
        hint: 'use ?from=YYYY-MM-DD&to=YYYY-MM-DD',
      });
    }

    const { rows } = await pool.query(
      `
      SELECT day AS fecha, total, tx_count
        FROM public.sales_daily
       WHERE business_id = $1
         AND day BETWEEN $2 AND $3
       ORDER BY day ASC
       LIMIT $4
      `,
      [bizId, from, to, limit]
    );

    const items = rows.map(r => ({
      fecha: r.fecha,                        // date
      total: Number(r.total || 0),          // ventas $
      tx_count: Number(r.tx_count || 0),    // cantidad de tickets
    }));

    const total = items.reduce((acc, r) => acc + r.total, 0);
    const txTotal = items.reduce((acc, r) => acc + r.tx_count, 0);

    return res.json({
      ok: true,
      business_id: bizId,
      from,
      to,
      total,
      tx_count: txTotal,
      items,
    });
  } catch (e) {
    next(e);
  }
};


/**
 * GET /api/businesses/:id/sales/:articuloId?from=YYYY-MM-DD&to=YYYY-MM-DD&groupBy=day|week|month
 * Serie por artículo usando sales_daily_items.
 */
exports.salesSeriesFromDB = async (req, res, next) => {
  try {
    const bizId =
      Number(req.business?.id) ||
      Number(req.params.id) ||
      Number(req.query.businessId);

    const articuloId = Number(req.params.articuloId);

    if (!Number.isFinite(bizId) || !Number.isFinite(articuloId)) {
      return res.status(400).json({ error: 'invalid_params' });
    }

    const from = String(req.query.from || '').slice(0, 10);
    const to   = String(req.query.to   || '').slice(0, 10);
    let groupBy = String(req.query.groupBy || 'day').toLowerCase();

    if (!from || !to) {
      return res.status(400).json({
        error: 'from_to_required',
        hint: 'use ?from=YYYY-MM-DD&to=YYYY-MM-DD',
      });
    }

    if (!['day', 'week', 'month'].includes(groupBy)) {
      groupBy = 'day';
    }

    const { rows } = await pool.query(
      `
      SELECT date_trunc($4, day)::date AS bucket,
             SUM(qty)::numeric        AS qty,
             SUM(amount)::numeric     AS amount
        FROM public.sales_daily_items
       WHERE business_id = $1
         AND article_id  = $2
         AND day BETWEEN $3 AND $5
       GROUP BY bucket
       ORDER BY bucket
      `,
      [bizId, articuloId, from, groupBy, to]
    );

    const items = rows.map(r => ({
      label: r.bucket,                // date
      qty: Number(r.qty || 0),
      amount: Number(r.amount || 0),
    }));

    const total = items.reduce((acc, r) => acc + r.qty, 0);

    return res.json({
      ok: true,
      business_id: bizId,
      articulo_id: articuloId,
      from,
      to,
      groupBy,
      total,
      items,
    });
  } catch (e) {
    next(e);
  }
};

