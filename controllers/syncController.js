// controllers/syncController.js
const { decryptSecretCompat } = require('../utils/cryptoField');
const pool = require('../config/db');
const fetch = global.fetch || require('node-fetch');

const BASE = (process.env.MAXI_BASE_URL || 'https://api-mconn.maxisistemas.com.ar').replace(/\/+$/, '');

// ---------- Helpers ----------
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

// ---- LOGIN a MCONN ----
async function maxiLogin({ email, password, codcli }) {
  const r = await fetch(`${BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, pass: password, cod_cli: codcli }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j?.resultCode !== 'SUCCESS' || !j?.content?.tokenAccess) {
    const id = j?.resultId || r.status;
    console.error('MAXI login failed', id, j);
    throw new Error(`maxi_login_failed_${id}`);
  }
  return j.content.tokenAccess;
}

// ---- ARTÍCULOS (menú extendido) ----
async function fetchMaxiArticles({ token, from, to }) {
  const u = new URL(`${BASE}/menuweb/menuextendido`);
  if (from) u.searchParams.set('fechaInicio', from);
  if (to)   u.searchParams.set('fechaFin', to);

  const r = await fetch(u, { headers: { Authorization: `Bearer ${token}` } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j?.resultCode !== 'SUCCESS') {
    console.error('MAXI articles fetch failed', r.status, j);
    throw new Error('maxi_articles_fetch_failed');
  }
  return Array.isArray(j.content) ? j.content : [];
}

// ---- UPSERT a public.maxi_articles (en chunks) ----
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

      const nombre    = String(it.descripcion ?? it.nombre ?? it.descripcionl ?? '').trim().slice(0, 200);
      const categoria = it.categoria ?? it.rubro ?? null;
      const subrubro  = it.subrubro ?? it.subRubro ?? null;
      const precio    = Number(it.precio ?? it.precioVenta ?? it.importe ?? 0) || 0;
      const costo     = Number(it.costo ?? it.costoPromedio ?? 0) || 0;

      //         biz    id     nombre ('' si null)     categoria default           subrubro default
      values.push(`($${p++},$${p++},COALESCE($${p++},''),COALESCE($${p++},'Sin categoría'),COALESCE($${p++},'Sin subrubro'),$${p++},$${p++},$${p++}::jsonb,NOW())`);
      params.push(businessId, id, nombre, categoria, subrubro, precio, costo, JSON.stringify(it));
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
    total += slice.length; // aprox. (insert + update cuentan 1 cada una)
  }

  return total;
}

// ---------------- Handlers ----------------

// POST /api/businesses/:id/sync  { scope: 'articles'|'sales'|'all', from?, to? }
exports.syncNow = async (req, res) => {
  const uid = req.user?.id;
  const businessId = Number(req.params.id);
  const { scope = 'articles', from, to } = req.body || {};
  if (!uid || !businessId) return res.status(400).json({ error: 'bad_request' });

  // pertenencia + props
  const { rows } = await pool.query(`
    SELECT b.props
      FROM app_businesses b
      LEFT JOIN user_businesses ub ON ub.business_id = b.id
     WHERE b.id=$1 AND (b.owner_id=$2 OR ub.user_id=$2)
     LIMIT 1
  `, [businessId, uid]);
  if (!rows[0]) return res.status(403).json({ error: 'forbidden' });

  // rango por defecto: mes corriente hasta ayer
  const today = new Date();
  const startOfMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const yesterday = addDays(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())), -1);
  const f = ymd(parseDate(from, startOfMonth));
  const t = ymd(parseDate(to, yesterday));

  // credenciales MAXI
  const mx = (rows[0].props || {}).maxi || {};
  const password = mx.pass_enc ? decryptSecretCompat(mx.pass_enc) : (mx.password || '');
  if (!(mx.email && password && mx.codcli)) {
    return res.status(400).json({ error: 'maxi_not_configured' });
  }

  const client = await pool.connect();
  try {
    const token = await maxiLogin({ email: mx.email, password, codcli: mx.codcli });

    let upserted = 0;

    if (scope === 'articles' || scope === 'all') {
      const items = await fetchMaxiArticles({ token, from: f, to: t });
      await client.query('BEGIN');
      upserted += await upsertArticles({ client, businessId, items });
      await client.query('COMMIT');
    }

    // Ventas: a implementar cuando tengamos endpoint real
    if (scope === 'sales') {
      return res.status(501).json({ error: 'not_implemented', detail: 'sales endpoint pending' });
    }

    return res.json({ ok: true, scope, from: f, to: t, upserted });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('syncNow error:', e);
    return res.status(500).json({ error: 'internal', message: e.message });
  } finally {
    client.release();
  }
};

// GET /api/businesses/:id/sales/summary?from&to
exports.salesSummaryFromDB = async (req, res) => {
  const uid = req.user?.id;
  const businessId = Number(req.params.id);
  if (!uid || !businessId) return res.status(400).json({ error: 'bad_request' });

  const { rows: ok } = await pool.query(`
    SELECT 1
    FROM app_businesses b
    LEFT JOIN user_businesses ub ON ub.business_id=b.id
    WHERE b.id=$1 AND (b.owner_id=$2 OR ub.user_id=$2)
    LIMIT 1`, [businessId, uid]);
  if (!ok[0]) return res.status(403).json({ error: 'forbidden' });

  const today = new Date();
  const startOfMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const yesterday = addDays(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())), -1);
  const from = ymd(parseDate(req.query.from, startOfMonth));
  const to   = ymd(parseDate(req.query.to,   yesterday));

  try {
    const { rows: items } = await pool.query(`
      SELECT articulo_id,
             SUM(qty)::numeric    AS qty,
             SUM(amount)::numeric AS amount
        FROM public.maxi_sales_daily
       WHERE business_id=$1
         AND day BETWEEN $2 AND $3
       GROUP BY articulo_id
       ORDER BY articulo_id
    `, [businessId, from, to]);

    return res.json({ from, to, items });
  } catch (err) {
    console.error('salesSummaryFromDB error', err);
    return res.status(500).json({ error: 'internal', detail: err.message });
  }
};

// GET /api/businesses/:id/sales/:articuloId?from&to&groupBy=day|week|month
exports.salesSeriesFromDB = async (req, res) => {
  const uid = req.user?.id;
  const businessId = Number(req.params.id);
  const articuloId = Number(req.params.articuloId);
  let { groupBy = 'day' } = req.query || {};
  if (!uid || !businessId || !Number.isFinite(articuloId)) {
    return res.status(400).json({ error: 'bad_request' });
  }

  const { rows: ok } = await pool.query(`
    SELECT 1
    FROM app_businesses b
    LEFT JOIN user_businesses ub ON ub.business_id=b.id
    WHERE b.id=$1 AND (b.owner_id=$2 OR ub.user_id=$2)
    LIMIT 1`, [businessId, uid]);
  if (!ok[0]) return res.status(403).json({ error: 'forbidden' });

  const today = new Date();
  const startOfMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const yesterday = addDays(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())), -1);
  const from = ymd(parseDate(req.query.from, startOfMonth));
  const to   = ymd(parseDate(req.query.to,   yesterday));

  groupBy = ['day', 'week', 'month'].includes(String(groupBy)) ? groupBy : 'day';

  if (groupBy === 'day') {
    const { rows } = await pool.query(`
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
    `, [businessId, articuloId, from, to]);
    return res.json({ from, to, groupBy, articuloId, items: rows });
  }

  const { rows } = await pool.query(`
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
  `, [businessId, articuloId, from, to, groupBy]);

  res.json({ from, to, groupBy, articuloId, items: rows });
};

// GET /api/businesses/:id/articles (desde tu BD)
exports.listArticlesFromDB = async (req, res) => {
  const uid = req.user?.id;
  const businessId = Number(req.params.id);
  if (!uid || !businessId) return res.status(400).json({ error: 'bad_request' });

  const { rows: ok } = await pool.query(`
    SELECT 1 FROM app_businesses b
    LEFT JOIN user_businesses ub ON ub.business_id=b.id
    WHERE b.id=$1 AND (b.owner_id=$2 OR ub.user_id=$2) LIMIT 1
  `, [businessId, uid]);
  if (!ok[0]) return res.status(403).json({ error: 'forbidden' });

  const { rows } = await pool.query(`
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
    ORDER BY nombre ASC
  `, [businessId]);

  res.json({ items: rows });
};

// (Opcional) GET /api/businesses/:id/maxi-articles?from&to  → proxy directo a MAXI (sin grabar)
exports.maxiArticlesProxy = async (req, res) => {
  const uid = req.user?.id;
  const businessId = Number(req.params.id);
  if (!uid || !businessId) return res.status(400).json({ error: 'bad_request' });

  const { rows } = await pool.query(`
    SELECT b.props
      FROM app_businesses b
      LEFT JOIN user_businesses ub ON ub.business_id=b.id
     WHERE b.id=$1 AND (b.owner_id=$2 OR ub.user_id=$2)
     LIMIT 1
  `, [businessId, uid]);
  if (!rows[0]) return res.status(403).json({ error: 'forbidden' });

  const mx = (rows[0].props || {}).maxi || {};
  const password = mx.pass_enc ? decryptSecretCompat(mx.pass_enc) : (mx.password || '');
  if (!(mx.email && password && mx.codcli)) {
    return res.status(400).json({ error: 'maxi_not_configured' });
  }

  const today = new Date();
  const startOfMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const yesterday = addDays(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())), -1);
  const from = ymd(parseDate(req.query.from, startOfMonth));
  const to   = ymd(parseDate(req.query.to,   yesterday));

  try {
    const token = await maxiLogin({ email: mx.email, password, codcli: mx.codcli });
    const items = await fetchMaxiArticles({ token, from, to });
    res.json({ from, to, items });
  } catch (e) {
    console.error('maxiArticlesProxy error:', e);
    res.status(500).json({ error: 'internal', detail: e.message });
  }
};
