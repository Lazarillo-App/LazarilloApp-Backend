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

function flattenMaxiMenu(tree = []) {
  const out = [];
  const seen = new Set();

  for (const rubro of (tree || [])) {
    const cat = String(rubro?.nombre || '').trim() || 'Sin categoría';

    // artículos directamente bajo rubro (por si existiera)
    for (const a of (rubro?.articulos || [])) {
      const id = Number(a?.id);
      if (!Number.isFinite(id) || seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        nombre: String(a?.nombre || '').trim(),
        precio: Number(a?.precio || 0) || 0,
        costo: 0,
        categoria: cat,
        subrubro: 'Sin subrubro',
        raw: a,
      });
    }

    for (const sr of (rubro?.subrubros || [])) {
      const sub = String(sr?.nombre || '').trim() || 'Sin subrubro';
      for (const a of (sr?.articulos || [])) {
        const id = Number(a?.id);
        if (!Number.isFinite(id) || seen.has(id)) continue;
        seen.add(id);
        out.push({
          id,
          nombre: String(a?.nombre || '').trim(),
          precio: Number(a?.precio || 0) || 0,
          costo: 0,
          categoria: cat,
          subrubro: sub,
          raw: a,
        });
      }
    }
  }
  return out;
}

function normalizeArticles(items = []) {
  if (!Array.isArray(items)) return [];
  const looksTree = items.some(it => it?.node_type === 'RUBRO' || it?.subrubros);
  if (looksTree) return flattenMaxiMenu(items);

  return items
    .map(it => ({
      id: Number(it.id ?? it.codigo ?? it.codigoArticulo ?? it.codart),
      nombre: String(it.nombre ?? it.descripcion ?? '').trim(),
      precio: Number(it.precio ?? it.precioVenta ?? it.importe ?? 0) || 0,
      costo: Number(it.costo ?? it.costoPromedio ?? 0) || 0,
      categoria: String(it.categoria ?? it.rubro ?? '').trim() || 'Sin categoría',
      subrubro: String(it.subrubro ?? it.subRubro ?? '').trim() || 'Sin subrubro',
      raw: it,
    }))
    .filter(a => Number.isFinite(a.id));
}

async function fetchMaxiArticles({ token, from, to }) {
  const u = new URL(`${BASE}/menuweb/menuextendido`);
  if (from) u.searchParams.set('fechaInicio', from);
  if (to) u.searchParams.set('fechaFin', to);

  const res = await fetchWithRetry(u.toString(), { headers: { Authorization: `Bearer ${token}` } });
  const j = await res.json().catch(() => ({}));
  if (j?.resultCode !== 'SUCCESS') throw new Error('maxi_articles_fetch_failed');
  const content = j?.content ?? [];

  // Caminata flexible (por si cambia el formato)
  const out = [];
  const seen = new Set();
  const isArticle = (o = {}) => {
    const keys = Object.keys(o || {});
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
    const costo = Number(o.costo ?? o.costoPromedio ?? 0) || 0;
    out.push({
      id,
      nombre,
      categoria: ctx.categoria ?? (o.categoria ?? o.rubro ?? null) ?? 'Sin categoría',
      subrubro: ctx.subrubro ?? (o.subrubro ?? o.subRubro ?? null) ?? 'Sin subrubro',
      precio,
      costo,
      raw: o,
    });
  };
  const walk = (node, ctx = { categoria: null, subrubro: null }) => {
    if (!node) return;
    if (Array.isArray(node)) return node.forEach(n => walk(n, ctx));
    if (typeof node !== 'object') return;

    const next = {
      categoria: (node.nombreRubro ?? node.rubroNombre ?? node.rubro?.descripcion ?? ctx.categoria) || ctx.categoria,
      subrubro: (node.nombreSubRubro ?? node.subRubro?.descripcion ?? node.subrubro ?? ctx.subrubro) || ctx.subrubro,
    };

    if (isArticle(node)) pushArt(node, next);

    for (const v of Object.values(node)) {
      if (v && (Array.isArray(v) || typeof v === 'object')) walk(v, next);
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

  // Fechas por defecto (half-open [from, to) para series en BD)
  const today = new Date();
  const startOfMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const yesterday = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 1));
  const f = ymd(parseDate(from, startOfMonth));
  const t = ymd(parseDate(to, yesterday));

  // Credenciales Maxi (solo en este endpoint)
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

      // Cachear payload por hash para evitar duplicaciones innecesarias
      const rawStr = JSON.stringify(rawItems ?? []);
      const hash   = simpleHash(rawStr);
      await pool.query(`
        INSERT INTO public.maxi_menu_cache (business_id, payload, hash, updated_at)
        VALUES ($1, $2::jsonb, $3, NOW())
        ON CONFLICT (business_id, hash) DO UPDATE SET updated_at = NOW()
      `, [businessId, rawStr, hash]);

      await client.query('BEGIN');

      const upserted = await upsertArticles({ client, businessId, items });

      // Ajuste de categorización desde el cache más reciente
      await client.query(
        `
WITH raw AS (
  SELECT payload
  FROM public.maxi_menu_cache
  WHERE business_id = $1
  ORDER BY updated_at DESC
  LIMIT 1
),
rubros AS (
  SELECT jsonb_array_elements(payload) AS r FROM raw
),
subs AS (
  SELECT (r->'raw'->>'nombre')::text AS categoria,
         jsonb_array_elements(r->'raw'->'subrubros') AS s
  FROM rubros
),
arts AS (
  SELECT categoria,
         (s->>'nombre')::text AS subrubro,
         jsonb_array_elements(s->'articulos') AS a
  FROM subs
),
map AS (
  SELECT (a->>'id')::int AS articulo_id,
         NULLIF(btrim(categoria), '') AS categoria,
         NULLIF(btrim(subrubro),  '') AS subrubro
  FROM arts
)
UPDATE public.maxi_articles m
   SET categoria  = COALESCE(map.categoria, m.categoria),
       subrubro   = COALESCE(map.subrubro,  m.subrubro),
       updated_at = NOW()
  FROM map
 WHERE m.business_id = $1
   AND m.articulo_id = map.articulo_id
`,
        [businessId]
      );

      await client.query('COMMIT');

      return res.json({ ok: true, scope: 'articles', upserted });
    }

    // Otros alcances a futuro (ventas, etc.) se responden neutros por ahora
    return res.json({ ok: true, scope, upserted: 0 });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('syncNow error:', e);
    return res.status(500).json({ error: 'internal', detail: e.message });
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
