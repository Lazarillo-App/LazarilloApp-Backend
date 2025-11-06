// routes/adminRebuildAggRoutes.js
const express = require('express');
const router = express.Router();
const pool = require('../config/db');

router.use(express.json()); // por si acaso

function isAllowed(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  return req.get('X-Cron-Secret') === secret;
}

const isYmd = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

// helper para elegir el primer valor no-nulo/indefinido
const pick = (...vals) => {
  for (const v of vals) if ((v ?? false) || v === '') return v; // permite '' como válido
  return undefined;
};

router.post('/rebuild-sales-agg', async (req, res) => {
  try {
    if (!isAllowed(req)) return res.status(401).json({ error: 'unauthorized' });

    const bizRaw = pick(req.body?.biz, req.query?.biz);
    const fromRaw = pick(req.body?.from, req.query?.from, '');
    const toRaw   = pick(req.body?.to,   req.query?.to,   '');

    const biz  = Number(bizRaw);
    const from = String(fromRaw);
    const to   = String(toRaw);

    if (!Number.isFinite(biz)) return res.status(400).json({ error: 'biz requerido' });
    if (!isYmd(from) || !isYmd(to)) return res.status(400).json({ error: 'from/to requeridos (YYYY-MM-DD)' });

    const q1 = `
      WITH params AS (
        SELECT $1::bigint AS biz, $2::date AS dfrom, $3::date AS dto
      ), agg AS (
        SELECT
          s.business_id,
          (s.occurred_at AT TIME ZONE 'UTC')::date AS day,
          SUM(s.total)::numeric(14,2)              AS total,
          COUNT(*)::int                            AS tx_count
        FROM app_sales s, params p
        WHERE s.business_id = p.biz
          AND (s.occurred_at AT TIME ZONE 'UTC')::date BETWEEN p.dfrom AND p.dto
        GROUP BY 1,2
      )
      INSERT INTO sales_daily (business_id, day, total, tx_count)
      SELECT business_id, day, total, tx_count
      FROM agg
      ON CONFLICT (business_id, day)
      DO UPDATE SET total = EXCLUDED.total,
                    tx_count = EXCLUDED.tx_count
      RETURNING day
    `;

    const q2 = `
      WITH params AS (
        SELECT $1::bigint AS biz, $2::date AS dfrom, $3::date AS dto
      ), agg_items AS (
        SELECT
          s.business_id,
          (s.occurred_at AT TIME ZONE 'UTC')::date AS day,
          i.article_id                              AS articulo_id,
          SUM(i.quantity)::numeric(14,3)            AS qty,
          SUM(i.total)::numeric(14,2)               AS amount
        FROM app_sales_items i
        JOIN app_sales s ON s.id = i.sale_id
        JOIN params p ON true
        WHERE s.business_id = p.biz
          AND (s.occurred_at AT TIME ZONE 'UTC')::date BETWEEN p.dfrom AND p.dto
          AND i.article_id IS NOT NULL
        GROUP BY 1,2,3
      )
      INSERT INTO sales_daily_items (business_id, articulo_id, "date", qty, amount)
      SELECT business_id, articulo_id, day, qty, amount
      FROM agg_items
      ON CONFLICT (business_id, articulo_id, "date")
      DO UPDATE SET qty    = EXCLUDED.qty,
                    amount = EXCLUDED.amount
      RETURNING "date"
    `;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const r1 = await client.query(q1, [biz, from, to]);
      const r2 = await client.query(q2, [biz, from, to]);
      await client.query('COMMIT');
      return res.json({
        ok: true,
        business_id: biz,
        range: { from, to },
        refreshed_days: r1.rowCount,
        refreshed_items_rows: r2.rowCount,
      });
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch {}
      throw e;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('rebuild-sales-agg error', err);
    res.status(500).json({ error: 'internal', message: err?.message });
  }
});

module.exports = router;
