// controllers/ventasController.js
// Fuente de verdad: nuestra DB (NO llama a Maxi).
// Endpoints:
//   - GET /api/ventas?peek=true&limit=N
//   - GET /api/ventas?from=YYYY-MM-DD&to=YYYY-MM-DD&groupBy=day|week|month
//   - LEGADO: GET /api/ventas/summary
//   - LEGADO: GET /api/ventas/:articuloId/series?from&to
//   - COMPAT: GET /api/ventas/by-article?articuloId=&from=&to=&groupBy=

const pool = require('../config/db');

// ====== Helpers fecha ======
const pad2  = n => String(n).padStart(2, '0');
const ymd   = d => `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
const at00  = d => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const addDays = (d, n) => new Date(at00(d).getTime() + n * 86400000);
const toDate  = (s) => (s ? new Date(s) : null);

// Clamp a AYER (evita “hoy”)
function clampRange(fromStr, toStr) {
  const todayUTC = at00(new Date());
  const AYER = addDays(todayUTC, -1);
  const F = toDate(fromStr) || addDays(todayUTC, -29);
  const T = toDate(toStr)   || AYER;
  const Tclamped = T > AYER ? AYER : T;
  return { F: at00(F), T: at00(Tclamped), AYER };
}

function getBusinessId(req) {
  return (
    Number(req.businessId) ||
    Number(req?.business?.id) ||
    Number(req?.activeBusiness?.id) ||
    Number(req.headers['x-business-id']) ||
    null
  );
}

// ====== GET /api/ventas ======
async function getVentas(req, res, next) {
  try {
    const businessId = getBusinessId(req);
    if (!businessId) return res.status(400).json({ error: 'Business no resuelto' });

    const { peek, limit, from, to, groupBy } = req.query;

    // Peek de comprobantes
    if (String(peek) === 'true') {
      const lim = Math.min(Math.max(parseInt(limit || '20', 10), 1), 200);
      const { rows } = await pool.query(
        `SELECT id::text, external_id, occurred_at, total::numeric(14,2)
           FROM app_sales
          WHERE business_id = $1
          ORDER BY occurred_at DESC
          LIMIT $2`,
        [businessId, lim]
      );
      return res.json({ ok: true, business_id: businessId, peek: rows });
    }

    // Series agregadas
    const { F, T } = clampRange(from, to);
    const gb = (groupBy || 'day').toLowerCase();
    if (!['day', 'week', 'month'].includes(gb)) {
      return res.status(400).json({ error: 'groupBy debe ser day|week|month' });
    }

    if (gb === 'day') {
      const { rows } = await pool.query(
        `SELECT day, total, tx_count
           FROM sales_daily
          WHERE business_id = $1
            AND day BETWEEN $2::date AND $3::date
          ORDER BY day ASC`,
        [businessId, ymd(F), ymd(T)]
      );
      return res.json({ ok: true, business_id: businessId, groupBy: 'day', series: rows });
    }

    const bucket = gb === 'week' ? 'week' : 'month';
    const { rows } = await pool.query(
      `SELECT date_trunc('${bucket}', day)::date AS bucket,
              SUM(total)::numeric(14,2)         AS total,
              SUM(tx_count)::int                 AS tx_count
         FROM sales_daily
        WHERE business_id = $1
          AND day BETWEEN $2::date AND $3::date
        GROUP BY 1
        ORDER BY 1 ASC`,
      [businessId, ymd(F), ymd(T)]
    );
    return res.json({ ok: true, business_id: businessId, groupBy: gb, series: rows });
  } catch (err) {
    next(err);
  }
}

// controllers/ventasController.js  (solo PATCH de handlers legacy)

// ====== LEGADO: ranking artículos (últimos 30 días) ======
async function getSummary(req, res, next) {
  try {
    const businessId = getBusinessId(req);
    if (!businessId) return res.status(400).json({ error: 'Business no resuelto' });

    const { F, T } = clampRange(null, null); // 30d hasta AYER por default
    const lim = Math.min(Math.max(parseInt(req.query.limit || '200', 10), 1), 1000);

    const { rows } = await pool.query(
      `SELECT sdi.article_id,
              SUM(sdi.qty)::numeric(14,3)    AS qty,
              SUM(sdi.amount)::numeric(14,2) AS amount
         FROM sales_daily_items sdi
        WHERE sdi.business_id = $1
          AND sdi.day BETWEEN $2::date AND $3::date
        GROUP BY sdi.article_id
        ORDER BY qty DESC
        LIMIT $4`,
      [businessId, ymd(F), ymd(T), lim]
    );

    return res.json({
      ok: true,
      business_id: businessId,
      rango: { from: ymd(F), to: ymd(T) },
      count: rows.length,
      items: rows
    });
  } catch (err) { next(err); }
}

// ====== LEGADO/COMPAT: serie por artículo (ID Maxi == article_id) ======
async function getArticleSeries(req, res, next) {
  try {
    const businessId = getBusinessId(req);
    if (!businessId) return res.status(400).json({ error: 'Business no resuelto' });

    const articuloId = Number(req.params.articuloId);
    if (!Number.isFinite(articuloId)) {
      return res.status(400).json({ error: 'articuloId inválido' });
    }

    const { F, T } = clampRange(req.query.from, req.query.to);

    // Calendario de días
    const days = [];
    for (let d = new Date(`${ymd(F)}T00:00:00Z`); d <= new Date(`${ymd(T)}T00:00:00Z`); d = addDays(d, 1)) {
      days.push(ymd(d));
    }

    const { rows } = await pool.query(
      `SELECT sdi.day AS day,
              SUM(sdi.qty)::numeric(14,3) AS qty
         FROM sales_daily_items sdi
        WHERE sdi.business_id = $1
          AND sdi.article_id  = $2
          AND sdi.day BETWEEN $3::date AND $4::date
        GROUP BY sdi.day
        ORDER BY sdi.day`,
      [businessId, articuloId, ymd(F), ymd(T)]
    );

    const map = new Map(rows.map(r => [String(r.day), Number(r.qty)]));
    const series = days.map(d => ({ date: d, qty: map.get(d) || 0 }));

    return res.json({
      ok: true,
      business_id: businessId,
      articuloId,
      rango: { from: ymd(F), to: ymd(T) },
      groupBy: 'day',
      data: series
    });
  } catch (err) { next(err); }
}

// ====== COMPAT: /api/ventas/by-article?articuloId=&from=&to=&groupBy= ======
async function getArticleSeriesQuery(req, res, next) {
  try {
    const businessId = getBusinessId(req);
    if (!businessId) return res.status(400).json({ error: 'Business no resuelto' });

    const articuloId = Number(req.query.articuloId);
    if (!Number.isFinite(articuloId)) {
      return res.status(400).json({ error: 'articuloId inválido' });
    }

    const gb = (req.query.groupBy || 'day').toLowerCase();
    if (!['day', 'week', 'month'].includes(gb)) {
      return res.status(400).json({ error: 'groupBy debe ser day|week|month' });
    }

    const F = req.query.from ? at00(new Date(req.query.from)) : null;
    const T = req.query.to ? at00(new Date(req.query.to)) : null;
    if (!F || !T || Number.isNaN(F.getTime()) || Number.isNaN(T.getTime()) || F > T) {
      return res.status(400).json({ error: 'from/to inválidos (YYYY-MM-DD)' });
    }
    const yf = ymd(F), yt = ymd(T);

    if (gb === 'day') {
      const { rows } = await pool.query(
        `SELECT sdi.day AS label,
                SUM(sdi.qty)::numeric(14,3) AS qty
           FROM sales_daily_items sdi
          WHERE sdi.business_id = $1
            AND sdi.article_id  = $2
            AND sdi.day BETWEEN $3::date AND $4::date
          GROUP BY sdi.day
          ORDER BY sdi.day`,
        [businessId, articuloId, yf, yt]
      );
      const items = rows.map(r => ({ label: String(r.label).slice(0,10), qty: Number(r.qty) || 0 }));
      const total = items.reduce((a, x) => a + x.qty, 0);
      return res.json({ ok: true, business_id: businessId, articuloId, groupBy: 'day', total, items });
    }

    const bucket = gb === 'week' ? 'week' : 'month';
    const { rows } = await pool.query(
      `SELECT date_trunc($5, sdi.day)::date AS label,
              SUM(sdi.qty)::numeric(14,3)   AS qty
         FROM sales_daily_items sdi
        WHERE sdi.business_id = $1
          AND sdi.article_id  = $2
          AND sdi.day BETWEEN $3::date AND $4::date
        GROUP BY 1
        ORDER BY 1`,
      [businessId, articuloId, yf, yt, bucket]
    );
    const items = rows.map(r => ({
      label: (r.label instanceof Date) ? r.label.toISOString().slice(0,10) : String(r.label).slice(0,10),
      qty: Number(r.qty) || 0
    }));
    const total = items.reduce((a, x) => a + x.qty, 0);
    return res.json({ ok: true, business_id: businessId, articuloId, groupBy: gb, total, items });
  } catch (err) { next(err); }
}

module.exports = {
  getVentas,
  getSummary,
  getArticleSeries,
  getArticleSeriesQuery,
};
