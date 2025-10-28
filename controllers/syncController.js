// controllers/syncController.js
const { decryptSecretCompat } = require('../utils/cryptoField');
const pool = require('../config/db');
const fetchNative = global.fetch || require('node-fetch');

const BASE = (process.env.MAXI_BASE_URL || 'https://api-mconn.maxisistemas.com.ar').replace(/\/+$/, '');
const FETCH_TIMEOUT_MS = Number(process.env.MAXI_FETCH_TIMEOUT_MS || 30000);
const FETCH_RETRIES = Number(process.env.MAXI_FETCH_RETRIES || 2);

/* ======================= Utils básicos ======================= */
function simpleHash(str = '') {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return String(h >>> 0);
}

function parseDate(d, fallback) {
  const x = new Date(d);
  return Number.isNaN(x.getTime()) ? new Date(fallback) : x;
}
function ymd(d) {
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

      // Reintenta en 429/5xx
      if ([429, 500, 502, 503, 504].includes(res.status) && attempt < retries) {
        await new Promise(r => setTimeout(r, 200 * (attempt + 1) ** 2));
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
        await new Promise(r => setTimeout(r, 200 * (attempt + 1) ** 2));
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr || new Error('fetchWithRetry unknown error');
}

/* =================== MAXI: login y artículos =================== */
async function maxiLogin({ email, password, codcli }) {
  const res = await fetchWithRetry(`${BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
 * Trae el menú extendido y lo convierte a un array plano de artículos
 * con SWAP: categoría app = subrubro Maxi, subrubro app = rubro Maxi.
 */
async function fetchMaxiArticles({ token, from, to }) {
  const u = new URL(`${BASE}/menuweb/menuextendido`);
  if (from) u.searchParams.set('fechaInicio', from);
  if (to) u.searchParams.set('fechaFin', to);

  const res = await fetchWithRetry(u.toString(), {
    headers: { Authorization: `Bearer ${token}` }
  });
  const j = await res.json().catch(() => ({}));
  if (j?.resultCode !== 'SUCCESS') throw new Error('maxi_articles_fetch_failed');

  // Árbol crudo tal como viene de Maxi (lo cacheamos)
  const raw = j?.content ?? [];

  // Aplanado para upsert
  const items = [];
  const seen = new Set();

  const isArticle = (o = {}) => {
    const hasId = ['id', 'idArticulo', 'codart', 'codigo', 'codigoArticulo'].some(k => k in o);
    const hasInfo = ['descripcion', 'descripcionl', 'nombre', 'precio', 'precioVenta', 'importe'].some(k => k in o);
    return hasId && hasInfo;
  };

  const pushArt = (o, ctx) => {
    const id = Number(o.id ?? o.idArticulo ?? o.codart ?? o.codigo ?? o.codigoArticulo);
    if (!Number.isFinite(id) || seen.has(id)) return;
    seen.add(id);

    const nombre = String(o.descripcion ?? o.descripcionl ?? o.nombre ?? '').trim();
    const precio = Number(o.precio ?? o.precioVenta ?? o.importe ?? 0) || 0;
    const costo  = Number(o.costo ?? o.costoPromedio ?? 0) || 0;

    // SWAP: categoría app = subrubro Maxi ; subrubro app = rubro Maxi
    const categoriaApp = (ctx.subrubro ?? o.subrubro ?? o.subRubro ?? null) || 'Sin subrubro';
    const subrubroApp  = (ctx.categoria ?? o.categoria ?? o.rubro ?? null)  || 'Sin categoría';

    items.push({
      id, nombre, precio, costo,
      categoria: categoriaApp,
      subrubro:  subrubroApp,
      raw: o,
    });
  };

  // Deriva contexto rubro/subrubro desde cualquier nodo
  const deriveCtx = (node, ctx) => {
    const rubroNombre =
      node?.nombreRubro ??
      node?.rubroNombre ??
      node?.rubro?.descripcion ??
      node?.rubro ??
      node?.raw?.categoria ??
      ctx.categoria;

    const subrubroNombre =
      node?.nombreSubRubro ??
      node?.subRubro?.descripcion ??
      node?.subrubro ??
      node?.raw?.subrubro ??
      ctx.subrubro;

    return {
      categoria: rubroNombre ?? ctx.categoria ?? null,   // rubro Maxi  → subrubro app
      subrubro:  subrubroNombre ?? ctx.subrubro ?? null, // subrubro Maxi → categoría app
    };
  };

  const walk = (node, ctx = { categoria: null, subrubro: null }) => {
    if (node == null) return;
    if (Array.isArray(node)) { for (const n of node) walk(n, ctx); return; }
    if (typeof node !== 'object') return;

    const next = deriveCtx(node, ctx);

    if (isArticle(node)) pushArt(node, next);

    for (const v of Object.values(node)) {
      if (v && (Array.isArray(v) || typeof v === 'object')) walk(v, next);
    }
  };

  // Caminata sobre el árbol crudo
  walk(raw);

  return { items, raw };
}

/* ========== Upsert en public.maxi_articles (chunked) ========== */
async function upsertArticles({ client, businessId, items }) {
  if (!items.length) return 0;
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

      const nombre = String(it.nombre ?? it.descripcion ?? it.descripcionl ?? '').slice(0, 200) || null;
      const categoria = String(it.categoria ?? '').trim() || 'Sin categoría';
      const subrubro  = String(it.subrubro  ?? '').trim() || 'Sin subrubro';
      const precio    = Number(it.precio ?? it.precioVenta ?? it.importe ?? 0) || 0;
      const costo     = Number(it.costo  ?? it.costoPromedio ?? 0) || 0;

      values.push(`($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++}::jsonb,NOW())`);
      params.push(businessId, id, nombre, categoria, subrubro, precio, costo, JSON.stringify(it.raw ?? it._raw ?? it));
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

/* ============================ Handlers ============================ */
exports.syncNow = async (req, res) => {
  const uid = req.user?.id;
  const businessId = req.businessId;
  const { scope = 'articles', from, to } = req.body || {};
  if (!uid || !businessId) return res.status(400).json({ error: 'no_active_business' });

  const today = new Date();
  const startOfMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const yesterday = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 1));
  const f = ymd(parseDate(from, startOfMonth));
  const t = ymd(parseDate(to, yesterday));

  const { rows: bizRows } = await pool.query(`SELECT props FROM app_businesses WHERE id=$1 LIMIT 1`, [businessId]);
  const mx = (bizRows[0]?.props || {}).maxi || {};
  const password = mx.pass_enc ? decryptSecretCompat(mx.pass_enc) : (mx.password || '');
  if (!(mx.email && password && mx.codcli)) return res.status(400).json({ error: 'maxi_not_configured' });

  const client = await pool.connect();
  try {
    const token = await maxiLogin({ email: mx.email, password, codcli: mx.codcli });

    if (scope === 'articles' || scope === 'all') {
      // 1) Trae artículos (plano) + árbol crudo
      const { items, raw } = await fetchMaxiArticles({ token, from: f, to: t });

      // 2) Cachea el árbol crudo con hash
      const rawStr = JSON.stringify(raw ?? []);
      const hash = simpleHash(rawStr);
      await pool.query(`
        INSERT INTO public.maxi_menu_cache (business_id, payload, hash, updated_at)
        VALUES ($1, $2::jsonb, $3, NOW())
        ON CONFLICT (business_id, hash) DO UPDATE SET updated_at = NOW()
      `, [businessId, rawStr, hash]);

      await client.query('BEGIN');

      // 3) Upsert de artículos (ya SWAPeados)
      const upserted = await upsertArticles({ client, businessId, items });

      // 4) Ajuste desde cache (lee último payload y aplica SWAP contra maxi_articles)
      const { rows: mapUpd } = await client.query(`
        WITH raw AS (
          SELECT payload
          FROM public.maxi_menu_cache
          WHERE business_id = $1
          ORDER BY updated_at DESC
          LIMIT 1
        ),
        content AS (
          SELECT CASE
            WHEN jsonb_typeof(payload) = 'array' THEN payload
            ELSE COALESCE(
              payload->'content',
              payload->'menu'->'content',
              payload->'data'->'content',
              '[]'::jsonb
            )
          END AS arr
          FROM raw
        ),
        rubros AS (
          SELECT jsonb_array_elements(arr) AS r FROM content
        ),
        subs AS (
          SELECT (r->'raw'->>'nombre')::text AS rubro_nombre,
                 jsonb_array_elements(COALESCE(r->'raw'->'subrubros','[]'::jsonb)) AS s
          FROM rubros
        ),
        arts AS (
          SELECT (s->>'nombre')::text AS categoria,     -- subrubro Maxi  → categoría app
                 rubro_nombre         AS subrubro,      -- rubro Maxi     → subrubro app
                 jsonb_array_elements(COALESCE(s->'articulos','[]'::jsonb)) AS a
          FROM subs
        ),
        map AS (
          SELECT (a->>'id')::int AS articulo_id,
                 NULLIF(btrim(categoria), '') AS categoria,
                 NULLIF(btrim(subrubro),  '') AS subrubro
          FROM arts
        ),
        updated AS (
          UPDATE public.maxi_articles m
             SET categoria  = COALESCE(map.categoria, m.categoria),
                 subrubro   = COALESCE(map.subrubro,  m.subrubro),
                 updated_at = NOW()
            FROM map
           WHERE m.business_id = $1
             AND m.articulo_id = map.articulo_id
           RETURNING 1
        )
        SELECT COUNT(*)::int AS updated_count FROM updated;
      `, [businessId]);
      const mappedFromCache = Number(mapUpd?.[0]?.updated_count || 0);

      // 5) Refresca tabla de mapeo (ON CONFLICT (business_id, articulo_id))
      const { rowCount: mapUpserts } = await client.query(`
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
               COALESCE(categoria, '[PENDIENTE]'),
               COALESCE(subrubro,  '[PENDIENTE]'),
               NOW()
        FROM src
        ON CONFLICT (business_id, articulo_id) DO UPDATE
        SET categoria  = EXCLUDED.categoria,
            subrubro   = EXCLUDED.subrubro,
            updated_at = NOW()
      `, [businessId]);

      await client.query('COMMIT');

      return res.json({
        ok: true,
        scope: 'articles',
        upserted,
        mapped_from_cache: mappedFromCache,
        mapped: mapUpserts,
        cacheHash: hash
      });
    }

    // otros alcances (ventas, etc.)
    return res.json({ ok: true, scope, upserted: 0 });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('syncNow error:', e?.stack || e);
    return res.status(500).json({ error: 'internal', detail: e?.message || String(e) });
  } finally {
    client.release();
  }
};

exports.salesSummaryFromDB = async (req, res) => {
  const uid = req.user?.id;
  const businessId = req.businessId;
  if (!uid || !businessId) return res.status(400).json({ error: 'no_active_business' });

  const today = new Date();
  const startOfMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const yesterday = addDays(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())), -1);
  const from = ymd(parseDate(req.query.from, startOfMonth));
  const to   = ymd(parseDate(req.query.to, yesterday));

  try {
    const { rows: items } = await pool.query(
      `
      SELECT articulo_id,
             SUM(qty)::numeric    AS qty,
             SUM(amount)::numeric AS amount
        FROM public.maxi_sales_daily
       WHERE business_id=$1
         AND day BETWEEN $2 AND $3
       GROUP BY articulo_id
       ORDER BY articulo_id
      `,
      [businessId, from, to]
    );
    return res.json({ from, to, items });
  } catch (err) {
    console.error('salesSummaryFromDB error', err);
    return res.status(500).json({ error: 'internal', detail: err.message });
  }
};

exports.salesSeriesFromDB = async (req, res) => {
  const uid = req.user?.id;
  const businessId = req.businessId;
  const articuloId = Number(req.params.articuloId);
  let { groupBy = 'day' } = req.query || {};
  if (!uid || !businessId || !Number.isFinite(articuloId)) {
    return res.status(400).json({ error: 'bad_request' });
  }

  const today = new Date();
  const startOfMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const yesterday = addDays(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())), -1);
  const from = ymd(parseDate(req.query.from, startOfMonth));
  const to   = ymd(parseDate(req.query.to, yesterday));
  groupBy = ['day', 'week', 'month'].includes(String(groupBy)) ? groupBy : 'day';

  if (groupBy === 'day') {
    const { rows } = await pool.query(
      `
      SELECT day AS bucket,
             SUM(qty)::numeric    AS qty,
             SUM(amount)::numeric AS amount
        FROM public.maxi_sales_daily
       WHERE business_id=$1
         AND articulo_id=$2
         AND day >= $3::date
         AND day  < $4::date
       GROUP BY day
       ORDER BY bucket
      `,
      [businessId, articuloId, from, to]
    );
    return res.json({ from, to, groupBy, articuloId, items: rows });
  }

  const { rows } = await pool.query(
    `
    SELECT date_trunc($5, day)::date AS bucket,
           SUM(qty)::numeric         AS qty,
           SUM(amount)::numeric      AS amount
      FROM public.maxi_sales_daily
     WHERE business_id=$1
       AND articulo_id=$2
       AND day >= $3::date
       AND day  < $4::date
     GROUP BY bucket
     ORDER BY bucket
    `,
    [businessId, articuloId, from, to, groupBy]
  );
  res.json({ from, to, groupBy, articuloId, items: rows });
};

exports.listArticlesFromDB = async (req, res) => {
  const uid = req.user?.id;
  const businessId = req.businessId;
  if (!uid || !businessId) return res.status(400).json({ error: 'no_active_business' });

  const { rows } = await pool.query(
    `
    SELECT
      articulo_id AS id,
      nombre,
      categoria,
      subrubro,
      precio,
      costo,
      raw
    FROM public.maxi_articles
    WHERE business_id = $1
    ORDER BY categoria, subrubro, nombre
    `,
    [businessId]
  );
  res.json({ items: rows });
};

exports.listArticlesTreeFromDB = async (req, res) => {
  const uid = req.user?.id;
  const businessId = req.businessId;
  if (!uid || !businessId) return res.status(400).json({ error: 'no_active_business' });

  try {
    const { rows } = await pool.query(
      `
      SELECT articulo_id, nombre, categoria, subrubro, precio
      FROM public.maxi_articles
      WHERE business_id = $1
      ORDER BY subrubro, categoria, nombre
      `,
      [businessId]
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

    res.json({
      ok: true,
      resumen: {
        subrubros: tree.length,
        categorias: tree.reduce((a, s) => a + (s.categorias?.length || 0), 0),
        articulos: tree.reduce((a, s) => a + s.categorias.reduce((x, c) => x + (c.articulos?.length || 0), 0), 0),
      },
      tree
    });
  } catch (e) {
    console.error('listArticlesTreeFromDB error:', e);
    res.status(500).json({ error: 'internal', detail: e.message });
  }
};

exports.maxiArticlesProxy = async (req, res) => {
  const uid = req.user?.id;
  const businessId = req.businessId;
  if (!uid || !businessId) return res.status(400).json({ error: 'no_active_business' });

  const today = new Date();
  const startOfMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const yesterday = addDays(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())), -1);
  const from = ymd(parseDate(req.query.from, startOfMonth));
  const to   = ymd(parseDate(req.query.to, yesterday));

  try {
    const { rows } = await pool.query(`SELECT props FROM app_businesses WHERE id=$1 LIMIT 1`, [businessId]);
    const mx = (rows[0]?.props || {}).maxi || {};
    const password = mx.pass_enc ? decryptSecretCompat(mx.pass_enc) : (mx.password || '');
    if (!(mx.email && password && mx.codcli)) return res.status(400).json({ error: 'maxi_not_configured' });

    const token = await maxiLogin({ email: mx.email, password, codcli: mx.codcli });
    const { items } = await fetchMaxiArticles({ token, from, to });
    res.json({ from, to, items });
  } catch (e) {
    console.error('maxiArticlesProxy error:', e);
    res.status(500).json({ error: 'internal', detail: e.message });
  }
};
