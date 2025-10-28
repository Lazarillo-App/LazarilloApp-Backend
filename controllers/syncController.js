// controllers/syncController.js
const { decryptSecretCompat } = require('../utils/cryptoField');
const pool = require('../config/db');
const fetchNative = global.fetch || require('node-fetch');

const BASE = (process.env.MAXI_BASE_URL || 'https://api-mconn.maxisistemas.com.ar').replace(/\/+$/, '');
const FETCH_TIMEOUT_MS = Number(process.env.MAXI_FETCH_TIMEOUT_MS || 30000);
const FETCH_RETRIES = Number(process.env.MAXI_FETCH_RETRIES || 2);

// -------------------- Utils básicos --------------------
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

// -------------------- Fetch con timeout + reintentos --------------------
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

// -------------------- MAXI: login y artículos --------------------
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

// Reemplaza flattenMaxiMenu/normalizeArticles por esto:
function extractArticlesFromMaxiPayload(payloadAny) {
  const arrRoot =
    Array.isArray(payloadAny) ? payloadAny :
    Array.isArray(payloadAny?.content) ? payloadAny.content :
    Array.isArray(payloadAny?.menu?.content) ? payloadAny.menu.content :
    Array.isArray(payloadAny?.data?.content) ? payloadAny.data.content :
    [];

  const out = [];
  const seen = new Set();

  // helpers
  const str = (v) => (v == null ? '' : String(v)).trim();
  const num = (v, d=0) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };
  const getId = (o={}) => num(o.id ?? o.idArticulo ?? o.codart ?? o.codigo ?? o.codigoArticulo, NaN);
  const isArticle = (o={}) => {
    if (!o || typeof o !== 'object') return false;
    const hasId = ['id','idArticulo','codart','codigo','codigoArticulo'].some(k => k in o);
    if (!hasId) return false;
    const hasNameOrPrice = ['nombre','descripcion','descripcionl','precio','precioVenta','importe'].some(k => k in o);
    const nodeTypeArticulo = str(o.node_type).toUpperCase() === 'ARTICULO';
    return hasId && (hasNameOrPrice || nodeTypeArticulo);
  };

  // toma nombre de rubro/subrubro desde node o desde node.raw
  const getRubroName = (node) =>
    str(node?.nombre) || str(node?.raw?.nombre) ||
    str(node?.nombreRubro) || str(node?.rubroNombre) || str(node?.rubro?.descripcion) ||
    'Sin subrubro'; // (rubro Maxi → subrubro app)

  const getSubrubroName = (node) =>
    str(node?.nombre) || str(node?.raw?.nombre) ||
    str(node?.nombreSubRubro) || str(node?.subRubro?.descripcion) || str(node?.subrubro) ||
    'Sin categoría'; // (subrubro Maxi → categoría app)

  // push con SWAP (subrubro Maxi → categoria app ; rubro Maxi → subrubro app)
  const pushArt = (a, ctx) => {
    const id = getId(a);
    if (!Number.isFinite(id) || seen.has(id)) return;
    seen.add(id);
    out.push({
      id,
      nombre: str(a.nombre ?? a.descripcion ?? a.descripcionl),
      precio: num(a.precio ?? a.precioVenta ?? a.importe, 0),
      costo:  num(a.costo ?? a.costoPromedio, 0),
      categoria: str(a?.raw?.subrubro) || str(ctx.subrubro) || 'Sin categoría', // SUB_RUBRO Maxi
      subrubro:  str(a?.raw?.categoria) || str(ctx.rubro)    || 'Sin subrubro',  // RUBRO Maxi
      raw: a,
    });
  };

  // walk recursivo: rubro → (subrubros → ...) → articulos
  const walkSub = (node, ctx) => {
    if (!node || typeof node !== 'object') return;

    // artículos en el subrubro
    const arts = node.articulos ?? node?.raw?.articulos ?? [];
    if (Array.isArray(arts)) {
      for (const a of arts) if (isArticle(a)) pushArt(a, ctx);
    }

    // sub-subrubros (si existieran)
    const subs = node.subrubros ?? node?.raw?.subrubros ?? [];
    if (Array.isArray(subs)) {
      for (const s of subs) {
        const nextCtx = {
          rubro:    ctx.rubro,
          subrubro: getSubrubroName(s) || ctx.subrubro,
        };
        walkSub(s, nextCtx);
      }
    }
  };

  const walkRubro = (r) => {
    const rubroNombre = getRubroName(r) || 'Sin subrubro'; // rubro Maxi → subrubro app
    // artículos colgados del rubro
    const artsR = r.articulos ?? r?.raw?.articulos ?? [];
    if (Array.isArray(artsR)) {
      for (const a of artsR) if (isArticle(a)) {
        pushArt(a, { rubro: rubroNombre, subrubro: 'Sin categoría' });
      }
    }
    // subrubros
    const subs = r.subrubros ?? r?.raw?.subrubros ?? [];
    if (Array.isArray(subs)) {
      for (const s of subs) {
        const ctx = { rubro: rubroNombre, subrubro: getSubrubroName(s) };
        walkSub(s, ctx);
      }
    }
  };

  for (const r of arrRoot) walkRubro(r);
  return out;
}
async function fetchMaxiArticles({ token, from, to }) {
  const u = new URL(`${BASE}/menuweb/menuextendido`);
  if (from) u.searchParams.set('fechaInicio', from);
  if (to) u.searchParams.set('fechaFin', to);

  const res = await fetchWithRetry(u.toString(), {
    headers: { Authorization: `Bearer ${token}` }
  });
  const j = await res.json().catch(() => ({}));
  if (j?.resultCode !== 'SUCCESS') throw new Error('maxi_articles_fetch_failed');

  // Normalizamos la raíz del payload
  const content =
    Array.isArray(j?.content) ? j.content :
    Array.isArray(j?.menu?.content) ? j.menu.content :
    Array.isArray(j?.data?.content) ? j.data.content :
    Array.isArray(j) ? j :
    [];

  const out = [];
  const seen = new Set();

  // Heurística: ¿esto parece un artículo?
  const isArticle = (o = {}) => {
    if (!o || typeof o !== 'object') return false;
    const hasId = ['id','idArticulo','codart','codigo','codigoArticulo']
      .some(k => k in o);
    const hasInfo = ['descripcion','descripcionl','nombre','precio','precioVenta','importe']
      .some(k => k in o);
    return hasId && hasInfo;
  };

  // Empuja un artículo con SWAP (subrubro Maxi → categoria app ; rubro Maxi → subrubro app)
  const pushArt = (o, ctx) => {
    const id = Number(o.id ?? o.idArticulo ?? o.codart ?? o.codigo ?? o.codigoArticulo);
    if (!Number.isFinite(id) || seen.has(id)) return;
    seen.add(id);

    const nombre = String(o.descripcion ?? o.descripcionl ?? o.nombre ?? '').trim();
    const precio = Number(o.precio ?? o.precioVenta ?? o.importe ?? 0) || 0;
    const costo  = Number(o.costo ?? o.costoPromedio ?? 0) || 0;

    // SWAP: en el contexto guardamos rubro en ctx.categoria y subrubro en ctx.subrubro
    //       para la app: categoria = subrubro Maxi ; subrubro = rubro Maxi
    const rubroMaxi     = ctx.categoria ?? o.categoria ?? o.rubro ?? null;
    const subrubroMaxi  = ctx.subrubro ?? o.subrubro ?? o.subRubro ?? null;

    out.push({
      id,
      nombre,
      categoria: subrubroMaxi ? String(subrubroMaxi).trim() : 'Sin subrubro',
      subrubro:  rubroMaxi    ? String(rubroMaxi).trim()    : 'Sin categoría',
      precio,
      costo,
      raw: o,
    });
  };

  // De un nodo cualquiera, intentamos extraer nombres de rubro/subrubro para el contexto
  const deriveCtx = (node, ctx) => {
    // Lo más común en Maxi:
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
      categoria: rubroNombre ?? ctx.categoria ?? null,    // rubro Maxi
      subrubro:  subrubroNombre ?? ctx.subrubro ?? null,  // subrubro Maxi
    };
  };

  // Caminata recursiva: pasa el contexto y encuentra artículos en cualquier nivel
  const walk = (node, ctx = { categoria: null, subrubro: null }) => {
    if (node == null) return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n, ctx);
      return;
    }
    if (typeof node !== 'object') return;

    const next = deriveCtx(node, ctx);

    // Si el nodo ya es un artículo, lo tomamos con el contexto actual
    if (isArticle(node)) pushArt(node, next);

    // Recorremos valores hijos (soporta r.subrubros, r.articulos y cualquier estructura anidada)
    for (const v of Object.values(node)) {
      if (v && (Array.isArray(v) || typeof v === 'object')) {
        walk(v, next);
      }
    }
  };

  walk(content);
  return out;
}

// -------------------- Upsert en public.maxi_articles --------------------
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
      const subrubro = String(it.subrubro ?? '').trim() || 'Sin subrubro';
      const precio = Number(it.precio ?? it.precioVenta ?? it.importe ?? 0) || 0;
      const costo = Number(it.costo ?? it.costoPromedio ?? 0) || 0;

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
// -------------------- Handlers --------------------
exports.syncNow = async (req, res) => {
  const uid = req.user?.id;
  const businessId = req.businessId;
  const { scope = 'articles', from, to } = req.body || {};
  if (!uid || !businessId) return res.status(400).json({ error: 'no_active_business' });

  // Fechas por defecto (half-open [from, to))
  const today = new Date();
  const startOfMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const yesterday = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 1));
  const f = ymd(parseDate(from, startOfMonth));
  const t = ymd(parseDate(to, yesterday));

  // Credenciales Maxi
  const { rows: bizRows } = await pool.query(`SELECT props FROM app_businesses WHERE id=$1 LIMIT 1`, [businessId]);
  const mx = (bizRows[0]?.props || {}).maxi || {};
  const password = mx.pass_enc ? decryptSecretCompat(mx.pass_enc) : (mx.password || '');
  if (!(mx.email && password && mx.codcli)) return res.status(400).json({ error: 'maxi_not_configured' });

  const client = await pool.connect();
  try {
    const token = await maxiLogin({ email: mx.email, password, codcli: mx.codcli });

    if (scope === 'articles' || scope === 'all') {
      const rawItems = await fetchMaxiArticles({ token, from: f, to: t });
      const items = normalizeArticles(rawItems);

      // Cachear payload por hash
      const rawStr = JSON.stringify(rawItems ?? []);
      const hash = simpleHash(rawStr);

      await client.query('BEGIN');

      // (Opcional) cachear dentro de la misma tx
      await client.query(`
        INSERT INTO public.maxi_menu_cache (business_id, payload, hash, updated_at)
        VALUES ($1, $2::jsonb, $3, NOW())
        ON CONFLICT (business_id, hash) DO UPDATE SET updated_at = NOW()
      `, [businessId, rawStr, hash]);

      // Upsert de artículos
      const upserted = await upsertArticles({ client, businessId, items });

      // Ajuste de categorización desde el cache más reciente (robusto + SWAP)
      // - categoría app   = SUB_RUBRO Maxi
      // - subrubro app    = RUBRO Maxi
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
    SELECT jsonb_array_elements(arr) AS r
    FROM content
  ),
  subs AS (
    SELECT
      (r->'raw'->>'nombre')::text AS rubro_nombre,
      jsonb_array_elements(COALESCE(r->'raw'->'subrubros','[]'::jsonb)) AS s
    FROM rubros
  ),
  arts AS (
    -- Caso 1: artículos dentro de subrubros
    SELECT
      (s->>'nombre')::text AS categoria,   -- SUB_RUBRO Maxi → categoría app
      rubro_nombre         AS subrubro,    -- RUBRO Maxi     → subrubro app
      jsonb_array_elements(COALESCE(s->'articulos','[]'::jsonb)) AS a
    FROM subs

    UNION ALL

    -- Caso 2: artículos colgados directo del rubro (sin subrubros)
    SELECT
      '[SIN SUBRUBRO]'::text AS categoria,
      (r->'raw'->>'nombre')::text AS subrubro,
      jsonb_array_elements(COALESCE(r->'raw'->'articulos','[]'::jsonb)) AS a
    FROM rubros r
  ),
  map AS (
    SELECT
      (a->>'id')::int                AS articulo_id,
      NULLIF(btrim(categoria), '')   AS categoria,
      NULLIF(btrim(subrubro),  '')   AS subrubro
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
      // Refrescar public.maxi_article_map desde maxi_articles (ya con SWAP aplicado)
      const { rowCount: mapUpserts } = await client.query(`
  WITH src AS (
    SELECT business_id, articulo_id,
           NULLIF(btrim(categoria),'') AS categoria,  -- subrubro Maxi → categoría app
           NULLIF(btrim(subrubro),'')  AS subrubro    -- rubro Maxi     → subrubro app
    FROM public.maxi_articles
    WHERE business_id = $1
  )
  INSERT INTO public.maxi_article_map (business_id, articulo_id, categoria, subrubro, updated_at)
  SELECT
    s.business_id, s.articulo_id,
    COALESCE(s.categoria,  '[PENDIENTE]'),
    COALESCE(s.subrubro,   '[PENDIENTE]'),
    NOW()
  FROM src s
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

    // Otros alcances a futuro
    return res.json({ ok: true, scope, upserted: 0 });
 } catch (e) {
  try { await client.query('ROLLBACK'); } catch {}
  console.error('syncNow error:', {
    msg: e.message, code: e.code, detail: e.detail, stack: e.stack
  });
  return res.status(500).json({ error: 'internal', detail: e.message });
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
  const to = ymd(parseDate(req.query.to, yesterday));

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
  const to = ymd(parseDate(req.query.to, yesterday));
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
  const to = ymd(parseDate(req.query.to, yesterday));

  try {
    const { rows } = await pool.query(`SELECT props FROM app_businesses WHERE id=$1 LIMIT 1`, [businessId]);
    const mx = (rows[0]?.props || {}).maxi || {};
    const password = mx.pass_enc ? decryptSecretCompat(mx.pass_enc) : (mx.password || '');
    if (!(mx.email && password && mx.codcli)) return res.status(400).json({ error: 'maxi_not_configured' });

    const token = await maxiLogin({ email: mx.email, password, codcli: mx.codcli });
    const items = await fetchMaxiArticles({ token, from, to });
    res.json({ from, to, items });
  } catch (e) {
    console.error('maxiArticlesProxy error:', e);
    res.status(500).json({ error: 'internal', detail: e.message });
  }
};
