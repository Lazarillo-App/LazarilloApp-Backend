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
// === MAXI: artículos con SWAP (subrubro Maxi -> categoria app ; rubro Maxi -> subrubro app)
async function fetchMaxiArticles({ token, from, to }) {
  const u = new URL(`${BASE}/menuweb/menuextendido`);
  if (from) u.searchParams.set('fechaInicio', from);
  if (to)   u.searchParams.set('fechaFin',   to);

  const res = await fetchWithRetry(u.toString(), {
    headers: { Authorization: `Bearer ${token}` }
  });
  const j = await res.json().catch(() => ({}));
  if (j?.resultCode !== 'SUCCESS') throw new Error('maxi_articles_fetch_failed');

  // El árbol real suele venir en content = [ { nombre, subrubros: [ { nombre, articulos: [...] } ] } ... ]
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

  const num = (v, d = 0) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };

  const getName = (o) =>
    String(o?.descripcion ?? o?.descripcionl ?? o?.nombre ?? '').trim();

  // PUSH con SWAP: categoría app = subrubro Maxi ; subrubro app = rubro Maxi
  const pushArt = (o, { rubroNombre, subrubroNombre }) => {
    const id = num(o.id ?? o.idArticulo ?? o.codart ?? o.codigo ?? o.codigoArticulo, NaN);
    if (!Number.isFinite(id) || seen.has(id)) return;
    seen.add(id);

    const nombre = getName(o);
    const precio = num(o.precio ?? o.precioVenta ?? o.importe, 0);
    const costo  = num(o.costo ?? o.costoPromedio, 0);

    items.push({
      id,
      nombre,
      // SWAP explícito:
      categoria: subrubroNombre || 'Sin subrubro',
      subrubro:  rubroNombre    || 'Sin categoría',
      precio,
      costo,
      raw: o,
    });
  };

  // Walker — rubro -> subrubros -> articulos
  for (const rubro of root) {
    const rubroNombre =
      String(
        rubro?.nombre ??
        rubro?.rubroNombre ??
        rubro?.rubro?.descripcion ??
        rubro?.rubro ??
        ''
      ).trim() || 'Sin subrubro'; // (recuerda: rubro Maxi luego lo usamos como "subrubro app")

    // Artículos colgados directo del rubro (poco común, pero lo soportamos)
    const artsRubro = Array.isArray(rubro?.articulos) ? rubro.articulos : [];
    for (const a of artsRubro) if (isArticle(a)) {
      // Si no hay subrubro, queda “Sin categoría” (porque en la app, categoría es subrubro Maxi)
      pushArt(a, { rubroNombre, subrubroNombre: 'Sin categoría' });
    }

    // Subrubros
    const subrubros = Array.isArray(rubro?.subrubros) ? rubro.subrubros : [];
    for (const s of subrubros) {
      const subrubroNombre =
        String(
          s?.nombre ??
          s?.nombreSubRubro ??
          s?.subRubro?.descripcion ??
          s?.subrubro ??
          ''
        ).trim() || 'Sin subrubro';

      // Artículos del subrubro
      const arts = Array.isArray(s?.articulos) ? s.articulos : [];
      for (const a of arts) if (isArticle(a)) {
        pushArt(a, { rubroNombre, subrubroNombre });
      }

      // (Opcional) Sub-subrubros si existieran
      const subs2 = Array.isArray(s?.subrubros) ? s.subrubros : [];
      for (const s2 of subs2) {
        const subSubNombre =
          String(s2?.nombre ?? s2?.nombreSubRubro ?? s2?.subRubro?.descripcion ?? s2?.subrubro ?? '').trim()
          || subrubroNombre;

        const arts2 = Array.isArray(s2?.articulos) ? s2.articulos : [];
        for (const a of arts2) if (isArticle(a)) {
          pushArt(a, { rubroNombre, subrubroNombre: subSubNombre });
        }
      }
    }
  }

  return { items, raw: root };
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

  // Credenciales Maxi del negocio
  const { rows: bizRows } = await pool.query(
    `SELECT props FROM app_businesses WHERE id=$1 LIMIT 1`,
    [businessId]
  );
  const mx = (bizRows[0]?.props || {}).maxi || {};
  const password = mx.pass_enc ? decryptSecretCompat(mx.pass_enc) : (mx.password || '');
  if (!(mx.email && password && mx.codcli)) {
    return res.status(400).json({ error: 'maxi_not_configured' });
  }

  const client = await pool.connect();
  try {
    const token = await maxiLogin({ email: mx.email, password, codcli: mx.codcli });

    if (scope === 'articles' || scope === 'all') {
      // 1) Traer artículos (plano SWAPeado) + árbol crudo
      const { items, raw } = await fetchMaxiArticles({ token, from: f, to: t });

      // 2) Cachear árbol crudo con hash (para auditoría/depuración)
      const rawStr = JSON.stringify(raw ?? []);
      const hash = simpleHash(rawStr);
      await pool.query(`
        INSERT INTO public.maxi_menu_cache (business_id, payload, hash, updated_at)
        VALUES ($1, $2::jsonb, $3, NOW())
        ON CONFLICT (business_id, hash) DO UPDATE SET updated_at = NOW()
      `, [businessId, rawStr, hash]);

      await client.query('BEGIN');

      // 3) Upsert de artículos (ya con categoría=subrubro Maxi y subrubro=rubro Maxi)
      const upserted = await upsertArticles({ client, businessId, items });

      // 4) Refrescar tabla de mapeo directo desde maxi_articles
      const { rowCount: mapped } = await client.query(`
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
        mapped,
        cacheHash: hash
      });
    }

    // Otros alcances (ventas, etc.)
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
