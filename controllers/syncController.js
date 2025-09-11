// controllers/syncController.js
const { decryptSecretCompat } = require('../utils/cryptoField');

const fetch = global.fetch || require('node-fetch');
const pool  = require('../config/db');

const BASE = process.env.MAXI_BASE_URL; // https://api-mconn.maxisistemas.com.ar

// ---- LOGIN a MCONN ----
async function maxiLogin({ email, password, codcli }) {
  const r = await fetch(`${BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type':'application/json' },
    body: JSON.stringify({ email, pass: password, cod_cli: codcli }),
  });
  const j = await r.json().catch(()=> ({}));
  if (!r.ok || j.resultCode !== 'SUCCESS') {
    const id = j?.resultId || r.status;
    console.error('MAXI login failed', id, j);
    throw new Error(`maxi_login_failed_${id}`);
  }
  return j.content.tokenAccess; // <-- token correcto
}

// ---- ARTÍCULOS (menú extendido) ----
async function fetchMaxiArticles({ token, from, to }) {
  const u = new URL(`${BASE}/menuweb/menuextendido`);
  if (from) u.searchParams.set('fechaInicio', from);
  if (to)   u.searchParams.set('fechaFin',   to);

  const r = await fetch(u, { headers: { Authorization: `Bearer ${token}` } });
  const j = await r.json().catch(()=> ({}));
  if (!r.ok || j.resultCode !== 'SUCCESS') throw new Error('maxi_articles_fetch_failed');
  return Array.isArray(j.content) ? j.content : [];
}

// Upsert a public.maxi_articles
async function upsertArticles({ client, businessId, items }) {
  if (!items.length) return 0;
  const values = [];
  const params = [];
  let p = 1;

  for (const it of items) {
    const id        = Number(it.id ?? it.codart ?? it.codigo ?? it.codigoArticulo);
    if (!Number.isFinite(id)) continue;
    const nombre    = String(it.descripcion ?? it.nombre ?? it.descripcionl ?? '').slice(0,200) || null;
    const categoria = String(it.categoria ?? it.rubro ?? '') || null;
    const subrubro  = String(it.subrubro ?? it.subRubro ?? '') || null;
    const precio    = Number(it.precio ?? it.precioVenta ?? it.importe ?? 0) || 0;
    const costo     = Number(it.costo ?? it.costoPromedio ?? 0) || 0;

    values.push(`($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},NOW())`);
    params.push(businessId, id, nombre, categoria, subrubro, precio, costo, JSON.stringify(it));
  }

  if (!values.length) return 0;
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
  return values.length;
}

// ---- dentro de exports.syncNow ----

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

  // rango de fechas
  const today = new Date();
  const startOfMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const yesterday    = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 1));
  const f = fmtDay(parseDate(from, startOfMonth));
  const t = fmtDay(parseDate(to,   yesterday));

  // credenciales MAXI (descifradas si hace falta)
  const mx = (rows[0].props || {}).maxi || {};
  const password = mx.pass_enc ? decryptSecret(mx.pass_enc) : (mx.password || '');
  if (!(mx.email && password && mx.codcli)) {
    return res.status(400).json({ error: 'maxi_not_configured' });
  }

  const client = await pool.connect();
  try {
    // 🔹 AQUÍ va el await (dentro del handler)
    const token = await maxiLogin({ email: mx.email, password, codcli: mx.codcli });

    let upserted = 0;

    // Sincronizar ARTÍCULOS (funciona hoy con MCONN)
    if (scope === 'articles' || scope === 'all') {
      const items = await fetchMaxiArticles({ token, from: f, to: t });
      await client.query('BEGIN');
      upserted += await upsertArticles({ client, businessId, items });
      await client.query('COMMIT');
    }

    // TODO: ventas cuando tengas el endpoint real
    // if (scope === 'sales' || scope === 'all') { ... }

    return res.json({ ok: true, scope, from: f, to: t, upserted });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('syncNow error:', e);
    return res.status(500).json({ error: 'internal', detail: e.message });
  } finally {
    client.release();
  }
};

// GET /api/businesses/:id/sales/summary?from&to
// → Totales por artículo (para pintar la tabla rápidamente, sin llamar a MAXI)
exports.salesSummaryFromDB = async (req, res) => {
  const uid = req.user?.id;
  const businessId = Number(req.params.id);
  if (!uid || !businessId) return res.status(400).json({ error: 'bad_request' });

  // pertenencia
  const { rows: ok } = await pool.query(`
    SELECT 1
    FROM app_businesses b
    LEFT JOIN user_businesses ub ON ub.business_id=b.id
    WHERE b.id=$1 AND (b.owner_id=$2 OR ub.user_id=$2)
    LIMIT 1`, [businessId, uid]);
  if (!ok[0]) return res.status(403).json({ error: 'forbidden' });

  const today = new Date();
  const startOfMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const yesterday = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 1));

  const from = fmtDay(parseDate(req.query.from, startOfMonth));
  const to = fmtDay(parseDate(req.query.to, yesterday));

  try {
    const { rows: items } = await pool.query(`
      SELECT articulo_id,
             SUM(qty)::numeric    AS qty,
             SUM(amount)::numeric AS amount
      FROM public.maxi_sales_daily
      WHERE business_id=$1 AND day BETWEEN $2 AND $3
      GROUP BY articulo_id
      ORDER BY articulo_id
    `, [businessId, from, to]);

    return res.json({ from, to, items });
  } catch (err) {
    console.error('salesSummaryFromDB error', err);
    return res.status(500).json({ error: 'internal', detail: err.message });
  }
};


// GET /api/businesses/:id/sales/:articuloId?from&to&groupBy=day|month
// → Serie para el modal de un artículo puntual
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
  const yesterday = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 1));

  const from = fmtDay(parseDate(req.query.from, startOfMonth));
  const to = fmtDay(parseDate(req.query.to, yesterday));

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
       ORDER BY bucket`, [businessId, articuloId, from, to]);

    return res.json({ from, to, groupBy, articuloId, items: rows });
  }

  // week / month
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
     ORDER BY bucket`, [businessId, articuloId, from, to, groupBy]);

  res.json({ from, to, groupBy, articuloId, items: rows });
};

// (ya lo tenías): listar artículos desde BD si lo necesitás en este mismo controlador
// GET /api/businesses/:id/articles
// controllers/syncController.js
// controllers/syncController.js
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
