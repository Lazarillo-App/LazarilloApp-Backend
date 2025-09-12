// controllers/syncController.js
const { decryptSecretCompat } = require('../utils/cryptoField');
const pool = require('../config/db');
const fetch = global.fetch || require('node-fetch');

const BASE = (process.env.MAXI_BASE_URL || 'https://api-mconn.maxisistemas.com.ar').replace(/\/+$/, '');

// helpers (ponelos arriba del archivo)
function pickDeep(obj, paths) {
  for (const p of paths) {
    const v = p.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return undefined;
}
function toIntLike(v) {
  if (v == null) return NaN;
  // extrae dígitos para casos como "0265" o "265A"
  const s = String(v).match(/\d+/g)?.join('') ?? '';
  return s ? Number.parseInt(s, 10) : NaN;
}
function toNum(v) {
  if (v == null || v === '') return 0;
  // "3.700,50" -> "3700.50"
  const s = String(v).replace(/\./g, '').replace(',', '.');
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

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
// ---- ARTÍCULOS (menú extendido) ----
async function fetchMaxiArticles({ token, from, to }) {
  const u = new URL(`${BASE}/menuweb/menuextendido`);
  if (from) u.searchParams.set('fechaInicio', from);
  if (to) u.searchParams.set('fechaFin', to);

  const r = await fetch(u, { headers: { Authorization: `Bearer ${token}` } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.resultCode !== 'SUCCESS') throw new Error('maxi_articles_fetch_failed');

  const out = [];

  const isArticle = (o = {}) => {
    const keys = Object.keys(o);
    const hasId   = ['id','idArticulo','codart','codigo','codigoArticulo'].some(k => k in o);
    const hasInfo = ['descripcion','descripcionl','nombre','precio','precioVenta','importe'].some(k => k in o);
    return hasId && hasInfo;
  };

  const pushArt = (o, ctx) => {
    const id      = Number(o.id ?? o.idArticulo ?? o.codart ?? o.codigo ?? o.codigoArticulo);
    if (!Number.isFinite(id)) return;
    const nombre  = String(o.descripcion ?? o.descripcionl ?? o.nombre ?? '').trim();
    const precio  = Number(o.precio ?? o.precioVenta ?? o.importe ?? 0) || 0;
    const costo   = Number(o.costo ?? o.costoPromedio ?? 0) || 0;
    out.push({
      id,
      nombre,
      categoria: ctx.categoria ?? (o.categoria ?? o.rubro ?? null),
      subrubro : ctx.subrubro  ?? (o.subrubro ?? o.subRubro ?? null),
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
      subrubro : (node.nombreSubRubro ?? node.subRubro?.descripcion ?? node.subrubro ?? ctx.subrubro) || ctx.subrubro,
    };

    if (isArticle(node)) pushArt(node, next);

    for (const v of Object.values(node)) {
      if (v && (Array.isArray(v) || typeof v === 'object')) walk(v, next);
    }
  };

  walk(j.content);

  // de-dupe por id
  const seen = new Set();
  return out.filter(a => !seen.has(a.id) && seen.add(a.id));
}

// ---- UPSERT a public.maxi_articles (en chunks) ----
// upsertArticles robusto
function firstText(...vals) {
  for (const v of vals) {
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return null;
}

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

      const nombre = firstText(
        it.nombre, it.Nombre,
        it.descripcion, it.descripcionL, it.descripcionl,
        it.detalle, it.articulo, it.desc, it.Descripcion
      ) || `#${id}`;

      // MUCHOS alias posibles que he visto en APIs similares
      const categoria = firstText(
        it.categoria, it.Categoria,
        it.rubro, it.Rubro, it.rubroNombre, it.RubroNombre,
        it.familia, it.Familia,
        it.seccion, it.Seccion,
        it.departamento, it.Departamento,
        it.grupo, it.Grupo
      ) || 'Sin categoría';

      const subrubro = firstText(
        it.subrubro, it.Subrubro, it.subRubro, it.SubRubro,
        it.subrubroNombre, it.SubrubroNombre,
        it.subcategoria, it.Subcategoria, it.subCategoria, it.SubCategoria,
        it.linea, it.Linea,
        it.grupo2, it.Grupo2
      ) || 'Sin subrubro';

      const precio = Number(
        it.precio ?? it.Precio ??
        it.precioVenta ?? it.PrecioVenta ??
        it.importe ?? it.Importe ?? 0
      ) || 0;

      const costo = Number(
        it.costo ?? it.Costo ??
        it.costoPromedio ?? it.CostoPromedio ?? 0
      ) || 0;

      values.push(`($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++}::jsonb,NOW())`);
      params.push(
        businessId,
        id,
        nombre,
        categoria,
        subrubro,
        precio,
        costo,
        JSON.stringify(it)
      );
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
    total += values.length;
  }

  return total;
}
// ---------------- Handlers ----------------

// controllers/syncController.js
// POST /api/businesses/:id/sync  { scope: 'articles' | 'sales' | 'all', from?, to? }
exports.syncNow = async (req, res) => {
  const uid = req.user?.id;
  const businessId = Number(req.params.id);
  const { scope = 'articles', from, to } = req.body || {};
  if (!uid || !businessId) return res.status(400).json({ error: 'bad_request' });

  // Verificación de pertenencia + props
  const { rows } = await pool.query(`
    SELECT b.props
      FROM app_businesses b
      LEFT JOIN user_businesses ub ON ub.business_id = b.id
     WHERE b.id=$1 AND (b.owner_id=$2 OR ub.user_id=$2)
     LIMIT 1
  `, [businessId, uid]);
  if (!rows[0]) return res.status(403).json({ error: 'forbidden' });

  // Credenciales MAXI
  const mx = (rows[0].props || {}).maxi || {};
  const password = mx.pass_enc ? decryptSecretCompat(mx.pass_enc) : (mx.password || '');
  if (!(mx.email && password && mx.codcli)) {
    return res.status(400).json({ error: 'maxi_not_configured' });
  }

  const client = await pool.connect();
  try {
    const token = await maxiLogin({ email: mx.email, password, codcli: mx.codcli });

    // ======================
    //  ARTÍCULOS (FULL SYNC)
    // ======================
    if (scope === 'articles' || scope === 'all') {
      const items = await fetchMaxiArticles({ token }); // <-- sin fechas
      await client.query('BEGIN');
      const upserted = await upsertArticles({ client, businessId, items });
      await client.query('COMMIT');
      return res.json({ ok: true, scope: 'articles', upserted });
    }

    // ======================
    //  VENTAS (por rango) – aún no implementado aquí
    // ======================
    if (scope === 'sales') {
      // Cuando esté listo:
      // const today = new Date();
      // const startOfMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
      // const yesterday = addDays(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())), -1);
      // const f = ymd(parseDate(from, startOfMonth));
      // const t = ymd(parseDate(to,   yesterday));
      // const ventas = await fetchMaxiSales({ token, from: f, to: t });
      // await client.query('BEGIN');
      // const upserted = await upsertSalesDaily({ client, businessId, ventas });
      // await client.query('COMMIT');
      // return res.json({ ok: true, scope: 'sales', from: f, to: t, upserted });

      return res.status(501).json({ error: 'not_implemented', detail: 'sales_sync_pending' });
    }

    // Alcance desconocido
    return res.status(400).json({ error: 'bad_request', detail: 'invalid_scope' });

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
  const to = ymd(parseDate(req.query.to, yesterday));

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
  const to = ymd(parseDate(req.query.to, yesterday));

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
  const to = ymd(parseDate(req.query.to, yesterday));

  try {
    const token = await maxiLogin({ email: mx.email, password, codcli: mx.codcli });
    const items = await fetchMaxiArticles({ token, from, to });
    res.json({ from, to, items });
  } catch (e) {
    console.error('maxiArticlesProxy error:', e);
    res.status(500).json({ error: 'internal', detail: e.message });
  }
};
