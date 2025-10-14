// controllers/ventasController.js
// Fuente de verdad: nuestra DB (NO llama a Maxi).
// Endpoints soportados:
//   - GET /api/ventas?peek=true&limit=N
//   - GET /api/ventas?from=YYYY-MM-DD&to=YYYY-MM-DD&groupBy=day|week|month
// Compatibilidad (rutas legadas):
//   - GET /api/ventas/summary           -> ranking artículos últimos 30d (desde app_sales_items)
//   - GET /api/ventas/:articuloId/series?from&to  -> series por día para un artículo

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || undefined,
  ssl: (process.env.PGSSLMODE === 'disable') ? false : { rejectUnauthorized: false }
});

// ---------- helpers fecha ----------
const pad2 = n => String(n).padStart(2, '0');
const ymd  = d => `${d.getUTCFullYear()}-${pad2(d.getUTCMonth()+1)}-${pad2(d.getUTCDate())}`;
const at00 = d => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const addDays = (d, n) => new Date(at00(d).getTime() + n * 86400000);

// Clamp a AYER (evita “hoy” por inconsistencias de origen)
function clampToAyer({ from, to }) {
  const today = at00(new Date());
  const AYERd = addDays(today, -1);
  const Fd = from ? at00(new Date(from)) : addDays(AYERd, -29);
  const Td = to   ? at00(new Date(to))   : AYERd;
  const T  = Td > AYERd ? AYERd : Td;
  return { from: ymd(Fd), to: ymd(T), AYER: ymd(AYERd) };
}

// ------------------------------------------------------------------
// GET /api/ventas?peek=true&limit=N  (últimos comprobantes)
// GET /api/ventas?from&to&groupBy=day|week|month  (series agregadas)
// ------------------------------------------------------------------
async function getVentas(req, res, next) {
  try {
    const businessId = req?.business?.id || req?.activeBusiness?.id;
    if (!businessId) return res.status(400).json({ error: 'Business no resuelto' });

    const { peek, limit, from, to, groupBy } = req.query;

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
      return res.json({ business_id: businessId, peek: rows });
    }

    if (!from || !to) {
      return res.status(400).json({ error: 'from/to requeridos (YYYY-MM-DD)' });
    }
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
        [businessId, from, to]
      );
      return res.json({ business_id: businessId, groupBy: 'day', series: rows });
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
        [businessId, from, to]
      );
      return res.json({ business_id: businessId, groupBy: gb, series: rows });
    }
  } catch (err) {
    next(err);
  }
}

// ------------------------------------------------------------------
// LEGADO: GET /api/ventas/summary
// Ranking de artículos por cantidad (últimos 30 días), desde app_sales_items.
// Requiere que app_sales_items.article_id esté mapeado (si no, devuelve vacío).
// Query opcional: ?limit=N (default 200)
// ------------------------------------------------------------------
async function getSummary(req, res, next) {
  try {
    const businessId = req?.business?.id || req?.activeBusiness?.id;
    if (!businessId) return res.status(400).json({ error: 'Business no resuelto' });

    const { from, to } = clampToAyer({}); // últimos 30 días
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
      [businessId, from, to]
    );

    return res.json({
      business_id: businessId,
      rango: { from, to },
      count: rows.length,
      items: rows
    });
  } catch (err) {
    next(err);
  }
}

// ------------------------------------------------------------------
// LEGADO: GET /api/ventas/:articuloId/series?from&to
// Serie diaria por cantidad para un artículo específico.
// Si no pasan fechas, usa últimos 30 días hasta AYER.
// ------------------------------------------------------------------
async function getArticleSeries(req, res, next) {
  try {
    const businessId = req?.business?.id || req?.activeBusiness?.id;
    if (!businessId) return res.status(400).json({ error: 'Business no resuelto' });

    const articuloId = Number(req.params.articuloId);
    if (!Number.isFinite(articuloId)) {
      return res.status(400).json({ error: 'articuloId inválido' });
    }

    const clamp = clampToAyer({ from: req.query.from, to: req.query.to });
    const F = clamp.from, T = clamp.to;

    // Construimos calendario de días
    const days = [];
    for (let d = new Date(F + 'T00:00:00Z'); d <= new Date(T + 'T00:00:00Z'); d = addDays(d, 1)) {
      days.push(ymd(d));
    }

    // Agregamos desde items
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
      [businessId, articuloId, F, T]
    );

    const map = new Map(rows.map(r => [String(r.day), Number(r.qty)]));
    const series = days.map(d => ({ date: d, qty: map.get(d) || 0 }));

    return res.json({
      business_id: businessId,
      articuloId,
      rango: { from: F, to: T },
      groupBy: 'day',
      data: series
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  // Nuevo handler “oficial” para /api/ventas
  getVentas,
  // Compatibilidad con rutas legadas
  getSummary,
  getArticleSeries,
};
