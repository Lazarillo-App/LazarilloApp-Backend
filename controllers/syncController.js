// controllers/syncController.js
const { decryptSecret } = require('../utils/cryptoField');

const pool = require('../config/db');
const fetch = global.fetch || require('node-fetch');

// ---------- Helpers ----------
function parseDate(d, fallback) {
  const x = new Date(d);
  return isNaN(x) ? new Date(fallback) : x;
}
function fmtDay(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function addDays(d, n) { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; }

// Agrega items a INSERT por chunks para no superar límites de parámetros
async function upsertSalesDaily({ client, rows }) {
  if (!rows.length) return 0;
  const CHUNK = 500; // 500 filas por batch
  let total = 0;

  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    // (business_id, articulo_id, day, qty, amount, updated_at)
    const values = [];
    const params = [];
    let p = 1;
    for (const r of slice) {
      values.push(`($${p++}, $${p++}, $${p++}::date, $${p++}::numeric, $${p++}::numeric, NOW())`);
      params.push(r.business_id, r.articulo_id, r.day, r.qty, r.amount);
    }
    const sql = `
      INSERT INTO maxi_sales_daily (business_id, articulo_id, day, qty, amount, updated_at)
      VALUES ${values.join(',')}
      ON CONFLICT (business_id, articulo_id, day)
      DO UPDATE SET qty=EXCLUDED.qty, amount=EXCLUDED.amount, updated_at=NOW()
    `;
    const r = await client.query(sql, params);
    total += r.rowCount || slice.length; // rowCount puede no reflejar updates; lo aproximamos
  }
  return total;
}

// ------------- Llamadas a MAXI (ajustá endpoints reales) -------------
const LOGIN_PATH = process.env.MAXI_LOGIN_PATH || '/auth/login';

async function maxiLogin({ email, password }) {
  const BASE = process.env.MAXI_BASE_URL;
  const url  = `${BASE}${LOGIN_PATH}`;

  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ email, password })  // 👈 OJO: 'email' (no 'username')
  });

  const text = await r.text(); // para ver el error real si falla
  if (!r.ok) {
    console.error('MAXI login failed', r.status, text.slice(0, 800));
    throw new Error(`maxi_login_failed_${r.status}`);
  }

  let j = {};
  try { j = JSON.parse(text); } catch {}
  const token = j.token || j.access_token || j?.data?.token;
  if (!token) {
    console.error('MAXI login ok pero sin token en body:', j);
    throw new Error('maxi_login_no_token');
  }
  return token;
}

async function fetchMaxiSalesDaily({ token, codcli, from, to }) {
  const BASE = process.env.MAXI_BASE_URL;

  // ⚠️ Ajustá este endpoint a tu API real de MAXI
  const url = `${BASE}/ventas?codcli=${encodeURIComponent(codcli)}&from=${from}&to=${to}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error('maxi_sales_fetch_failed');

  const raw = await r.json();
  const list = Array.isArray(raw) ? raw : (raw?.data || []);

  // Normalizar + agregar por día
  const map = new Map(); // key: `${articuloId}|${day}`
  for (const it of list) {
    const day = String(it.fecha || it.day || '').slice(0, 10);
    const articuloId = Number(it.articuloId ?? it.codigo ?? it.codigoArticulo ?? it.id);
    const qty = Number(it.cantidad ?? it.qty ?? 0);
    const amount = Number(it.monto ?? it.amount ?? 0);
    if (!day || !Number.isFinite(articuloId)) continue;

    const k = `${articuloId}|${day}`;
    const prev = map.get(k) || { qty: 0, amount: 0 };
    map.set(k, { qty: prev.qty + qty, amount: prev.amount + amount });
  }

  // -> [{ articulo_id, day, qty, amount }]
  const out = [];
  for (const [k, v] of map.entries()) {
    const [aid, day] = k.split('|');
    out.push({ articulo_id: Number(aid), day, qty: v.qty, amount: v.amount });
  }
  return out;
}

// ------------- Handlers públicos -------------

// POST /api/businesses/:id/sync  body: { scope:'sales'|'articles'|'all', from?, to? }
exports.syncNow = async (req, res) => {
  const uid = req.user?.id;
  const businessId = Number(req.params.id);
  const { scope = 'sales', from, to } = req.body || {};
  if (!uid || !businessId) return res.status(400).json({ error: 'bad_request' });

  // pertenencia + props
  const { rows } = await pool.query(`
    SELECT b.props
    FROM app_businesses b
    LEFT JOIN user_businesses ub ON ub.business_id=b.id
    WHERE b.id=$1 AND (b.owner_id=$2 OR ub.user_id=$2)
    LIMIT 1`, [businessId, uid]);
  if (!rows[0]) return res.status(403).json({ error: 'forbidden' });

  // Rango por defecto: mes corriente hasta ayer
  const today = new Date();
  const startOfMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const yesterday = addDays(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())), -1);

  const f = fmtDay(parseDate(from, startOfMonth));
  const t = fmtDay(parseDate(to, yesterday));

  // MAXI creds
  const mx = (rows[0].props || {}).maxi || {};
  const password = mx.pass_enc ? decryptSecret(mx.pass_enc) : (mx.password || '');

  if (!(mx.email && password && mx.codcli)) {
    return res.status(400).json({ error: 'maxi_not_configured' });
  }

  const client = await pool.connect();
  try {
    const token = await maxiLogin({ email: mx.email, password });

    let upserted = 0;

    if (scope === 'sales' || scope === 'all') {
      const daily = await fetchMaxiSalesDaily({ token, codcli: mx.codcli, from: f, to: t });
      // Agregar business_id y upsert
      const rowsToUpsert = daily.map(d => ({
        business_id: businessId,
        articulo_id: d.articulo_id,
        day: d.day,
        qty: d.qty,
        amount: d.amount
      }));

      await client.query('BEGIN');
      upserted += await upsertSalesDaily({ client, rows: rowsToUpsert });
      await client.query('COMMIT');
    }

    // (Opcional) si scope==='articles' acá guardarías el catálogo en tu tabla de artículos

    return res.json({ ok: true, scope, from: f, to: t, upserted });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { }
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
