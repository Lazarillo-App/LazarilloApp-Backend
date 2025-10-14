// controllers/ventasController.js
// Fuente de verdad: nuestra DB (NO llama a Maxi).
// Endpoints:
//   - GET /api/ventas?peek=true&limit=N
//   - GET /api/ventas?from=YYYY-MM-DD&to=YYYY-MM-DD&groupBy=day|week|month  (from/to opcionales; default últimos 30 días)
//   - LEGADO: GET /api/ventas/summary
//   - LEGADO: GET /api/ventas/:articuloId/series?from&to

const pool = require('../config/db');

// ====== Helpers fecha ======
const pad2 = n => String(n).padStart(2, '0');
const ymd  = d => `${d.getUTCFullYear()}-${pad2(d.getUTCMonth()+1)}-${pad2(d.getUTCDate())}`;
const at00 = d => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const addDays = (d, n) => new Date(at00(d).getTime() + n * 86400000);
const toDate = (s) => (s ? new Date(s) : null);

// Clamp a AYER (evita “hoy” por inconsistencias del origen)
function clampRange(fromStr, toStr) {
  const now = new Date();
  const todayUTC = at00(now);
  const AYER = addDays(todayUTC, -1);

  const F = toDate(fromStr) || addDays(todayUTC, -29);
  const T = toDate(toStr)   || AYER;

  const Tclamped = T > AYER ? AYER : T;
  return { F, T: Tclamped, AYER };
}

// ====== GET /api/ventas ======
async function getVentas(req, res, next) {
  try {
    const businessId = req?.business?.id || req?.activeBusiness?.id || Number(req.headers['x-business-id']);
    if (!businessId) return res.status(400).json({ error: 'Business no resuelto' });

    const { peek, limit, from, to, groupBy } = req.query;

    // ---- Peek: últimos comprobantes ----
    if (String(peek) === 'true') {
      const lim = Math.min(Math.max(parseInt(limit || '20', 10), 1), 200);
      const { rows } = await pool.query(
        `SELECT id, external_id, occurred_at, total
           FROM app_sales
          WHERE business_id = $1
          ORDER BY occurred_at DESC
          LIMIT ${lim}`,
        [businessId]
      );
      return res.json({ ok: true, business_id: businessId, peek: rows });
    }

    // ---- Series: day/week/month (from/to opcionales -> defaults) ----
    const { F, T } = clampRange(from, to);
    const gb = (groupBy || 'day').toLowerCase();
    if (!['day','week','month'].includes(gb)) {
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
    } else {
      const bucket = gb === 'week' ? 'week' : 'month';
      const { rows } = await pool.query(
        `SELECT date_trunc('${bucket}', day)::date AS bucket,
                SUM(total)::numeric(14,2) AS total,
                SUM(tx_count)::int         AS tx_count
           FROM sales_daily
          WHERE business_id = $1
            AND day BETWEEN $2::date AND $3::date
          GROUP BY 1
          ORDER BY 1 ASC`,
        [businessId, ymd(F), ymd(T)]
      );
      return res.json({ ok: true, business_id: businessId, groupBy: gb, series: rows });
    }
  } catch (err) {
    next(err);
  }
}

// ====== LEGADO: ranking artículos (últimos 30 días) ======
async function getSummary(req, res, next) {
  try {
    const businessId = req?.business?.id || req?.activeBusiness?.id || Number(req.headers['x-business-id']);
    if (!businessId) return res.status(400).json({ error: 'Business no resuelto' });

    const { F, T } = clampRange(null, null); // default 30d hasta AYER
    const lim = Math.min(Math.max(parseInt(req.query.limit || '200', 10), 1), 1000);

    const { rows } = await pool.query(
      `SELECT i.article_id,
              SUM(i.quantity)::numeric(14,3) AS qty
         FROM app_sales_items i
         JOIN app_sales s ON s.id = i.sale_id
        WHERE s.business_id = $1
          AND (s.occurred_at AT TIME ZONE 'UTC')::date BETWEEN $2::date AND $3::date
          AND i.article_id IS NOT NULL
        GROUP BY 1
        ORDER BY qty DESC
        LIMIT ${lim}`,
      [businessId, ymd(F), ymd(T)]
    );

    return res.json({
      ok: true,
      business_id: businessId,
      rango: { from: ymd(F), to: ymd(T) },
      count: rows.length,
      items: rows
    });
  } catch (err) {
    next(err);
  }
}

// ====== LEGADO: serie diaria por artículo ======
async function getArticleSeries(req, res, next) {
  try {
    const businessId = req?.business?.id || req?.activeBusiness?.id || Number(req.headers['x-business-id']);
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

    // Agregado desde items
    const { rows } = await pool.query(
      `SELECT (s.occurred_at AT TIME ZONE 'UTC')::date AS day,
              SUM(i.quantity)::numeric(14,3)         AS qty
         FROM app_sales_items i
         JOIN app_sales s ON s.id = i.sale_id
        WHERE s.business_id = $1
          AND i.article_id = $2
          AND (s.occurred_at AT TIME ZONE 'UTC')::date BETWEEN $3::date AND $4::date
        GROUP BY 1
        ORDER BY 1`,
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
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getVentas,
  getSummary,
  getArticleSeries,
};
