// controllers/ventasController.js
// Fuente de verdad: nuestra DB (NO llama a Maxi).
// Endpoints:
//   - GET /api/ventas?peek=true&limit=N
//   - GET /api/ventas?from=YYYY-MM-DD&to=YYYY-MM-DD&groupBy=day|week|month
//   - LEGADO: GET /api/ventas/summary
//   - LEGADO: GET /api/ventas/:articuloId/series?from&to
//   - COMPAT: GET /api/ventas/by-article?articuloId=&from=&to=&groupBy=

const crypto = require('crypto');

const { cached, makeKey } = require('../utils/cache');
const { validateClampRange } = require('../utils/range');
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

    // Peek de comprobantes (si esto lo usás para Maxi/app_sales, lo dejamos tal cual)
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

    // Series agregadas (desde items, prefiriendo CSV sobre MAXI)
    const { F, T } = clampRange(from, to);
    const gb = (groupBy || 'day').toLowerCase();
    if (!['day', 'week', 'month'].includes(gb)) {
      return res.status(400).json({ error: 'groupBy debe ser day|week|month' });
    }

    // Base: para cada (day, article_id) elegimos CSV si existe, si no MAXI.
    const basePreferredSql = `
      WITH preferred AS (
        SELECT DISTINCT ON (sdi.day, sdi.article_id)
          sdi.day,
          sdi.article_id,
          sdi.qty,
          sdi.amount
        FROM sales_daily_items sdi
        WHERE sdi.business_id = $1
          AND sdi.day BETWEEN $2::date AND $3::date
          AND sdi.source IN ('csv','maxi')
        ORDER BY sdi.day, sdi.article_id,
          CASE WHEN sdi.source = 'csv' THEN 0 ELSE 1 END
      )
    `;

    if (gb === 'day') {
      const { rows } = await pool.query(
        `
        ${basePreferredSql}
        SELECT
          day,
          SUM(amount)::numeric(14,2) AS total,
          0::int                     AS tx_count
        FROM preferred
        GROUP BY day
        ORDER BY day ASC
        `,
        [businessId, ymd(F), ymd(T)]
      );

      return res.json({ ok: true, business_id: businessId, groupBy: 'day', series: rows });
    }

    const bucket = gb === 'week' ? 'week' : 'month';
    const { rows } = await pool.query(
      `
      ${basePreferredSql}
      SELECT
        date_trunc($4, day)::date    AS bucket,
        SUM(amount)::numeric(14,2)   AS total,
        0::int                       AS tx_count
      FROM preferred
      GROUP BY 1
      ORDER BY 1 ASC
      `,
      [businessId, ymd(F), ymd(T), bucket]
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
    const businessId = req.activeBusinessId || Number(req.query.business_id);
    if (!businessId) return res.status(400).json({ ok:false, error:'business_id requerido' });

    const { from, to } = validateClampRange({
      from: req.query.from,
      to: req.query.to
    }, 31);

    const key = makeKey('ventas-summary', businessId, from, to);

    const data = await cached(key, async () => {
      const q = `
        SELECT
          fecha::date AS dia,
          SUM(total_neto)  AS neto,
          SUM(total_bruto) AS bruto,
          COUNT(*)         AS tickets
        FROM maxi_sales_daily
        WHERE business_id = $1
          AND fecha::date BETWEEN $2::date AND $3::date
        GROUP BY 1
        ORDER BY 1;
      `;
      const { rows } = await pool.query(q, [businessId, from, to]);
      return { ok:true, business_id: businessId, rango:{ from, to }, count: rows.length, items: rows };
    }, 300_000); // 5 min

    const etag = crypto.createHash('sha1').update(JSON.stringify(data)).digest('hex');
    if (req.headers['if-none-match'] === etag) return res.status(304).end();

    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'public, max-age=60');
    return res.json(data);
  } catch (e) {
    next(e);
  }
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

    // calendario continuo
    const days = [];
    for (
      let d = new Date(`${ymd(F)}T00:00:00Z`);
      d <= new Date(`${ymd(T)}T00:00:00Z`);
      d = addDays(d, 1)
    ) {
      days.push(ymd(d));
    }

    // Preferir CSV sobre MAXI por día
    const { rows } = await pool.query(
      `
      WITH preferred AS (
        SELECT DISTINCT ON (day)
          day,
          qty
        FROM sales_daily_items
        WHERE business_id = $1
          AND article_id  = $2
          AND day BETWEEN $3::date AND $4::date
          AND source IN ('csv','maxi')
        ORDER BY day,
          CASE WHEN source = 'csv' THEN 0 ELSE 1 END
      )
      SELECT day, qty
      FROM preferred
      ORDER BY day
      `,
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
      data: series,
    });
  } catch (err) {
    next(err);
  }
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
    const T = req.query.to   ? at00(new Date(req.query.to))   : null;
    if (!F || !T || Number.isNaN(F.getTime()) || Number.isNaN(T.getTime()) || F > T) {
      return res.status(400).json({ error: 'from/to inválidos (YYYY-MM-DD)' });
    }

    const yf = ymd(F), yt = ymd(T);

    if (gb === 'day') {
      const { rows } = await pool.query(
        `
        WITH preferred AS (
          SELECT DISTINCT ON (day)
            day,
            qty
          FROM sales_daily_items
          WHERE business_id = $1
            AND article_id  = $2
            AND day BETWEEN $3::date AND $4::date
            AND source IN ('csv','maxi')
          ORDER BY day,
            CASE WHEN source = 'csv' THEN 0 ELSE 1 END
        )
        SELECT day AS label, qty
        FROM preferred
        ORDER BY day
        `,
        [businessId, articuloId, yf, yt]
      );

      const items = rows.map(r => ({
        label: String(r.label).slice(0, 10),
        qty: Number(r.qty) || 0,
      }));

      const total = items.reduce((a, x) => a + x.qty, 0);

      return res.json({
        ok: true,
        business_id: businessId,
        articuloId,
        groupBy: 'day',
        total,
        items,
      });
    }

    const bucket = gb === 'week' ? 'week' : 'month';
    const { rows } = await pool.query(
      `
      WITH preferred AS (
        SELECT DISTINCT ON (day)
          day,
          qty
        FROM sales_daily_items
        WHERE business_id = $1
          AND article_id  = $2
          AND day BETWEEN $3::date AND $4::date
          AND source IN ('csv','maxi')
        ORDER BY day,
          CASE WHEN source = 'csv' THEN 0 ELSE 1 END
      )
      SELECT
        date_trunc($5, day)::date AS label,
        SUM(qty)::numeric(14,3)   AS qty
      FROM preferred
      GROUP BY 1
      ORDER BY 1
      `,
      [businessId, articuloId, yf, yt, bucket]
    );

    const items = rows.map(r => ({
      label: r.label instanceof Date
        ? r.label.toISOString().slice(0, 10)
        : String(r.label).slice(0, 10),
      qty: Number(r.qty) || 0,
    }));

    const total = items.reduce((a, x) => a + x.qty, 0);

    return res.json({
      ok: true,
      business_id: businessId,
      articuloId,
      groupBy: gb,
      total,
      items,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getVentas,
  getSummary,
  getArticleSeries,
  getArticleSeriesQuery,
};
