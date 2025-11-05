// routes/adminRebuildAggRoutes.js
const express = require('express');
const router = express.Router();
const pool = require('../config/db');

function isCronAllowed(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  return req.get('X-Cron-Secret') === secret;
}

/**
 * POST /admin/rebuild-sales-agg
 * Body:
 *  {
 *    biz: number | "all",     // negocio específico o "all"
 *    from: "YYYY-MM-DD",
 *    to:   "YYYY-MM-DD"
 *  }
 */
router.post('/rebuild-sales-agg', async (req, res) => {
  if (!isCronAllowed(req)) return res.status(401).json({ error: 'unauthorized' });

  const { biz = 'all', from, to } = req.body || {};
  if (!from || !to) return res.status(400).json({ error: 'from/to requeridos (YYYY-MM-DD)' });

  try {
    let businesses = [];
    if (biz === 'all') {
      const q = await pool.query(`SELECT id FROM app_businesses ORDER BY id`);
      businesses = q.rows.map(r => Number(r.id));
    } else {
      const id = Number(biz);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'biz inválido' });
      businesses = [id];
    }

    const details = [];
    for (const businessId of businesses) {
      // 1) sales_daily
      await pool.query(
        `
        WITH agg AS (
          SELECT
            s.business_id,
            (s.occurred_at AT TIME ZONE 'UTC')::date AS day,
            SUM(s.total)::numeric(14,2)              AS total,
            COUNT(*)::int                            AS tx_count
          FROM app_sales s
          WHERE s.business_id = $1
            AND (s.occurred_at AT TIME ZONE 'UTC')::date BETWEEN $2::date AND $3::date
          GROUP BY 1,2
        )
        INSERT INTO sales_daily (business_id, day, total, tx_count)
        SELECT business_id, day, total, tx_count
        FROM agg
        ON CONFLICT (business_id, day)
        DO UPDATE SET total = EXCLUDED.total,
                      tx_count = EXCLUDED.tx_count
        `,
        [businessId, from, to]
      );

      // 2) sales_daily_items
      const r = await pool.query(
        `
        WITH agg_items AS (
          SELECT
            s.business_id,
            (s.occurred_at AT TIME ZONE 'UTC')::date AS day,
            i.article_id                              AS articulo_id,
            SUM(i.quantity)::numeric(14,3)            AS qty,
            SUM(i.total)::numeric(14,2)               AS amount
          FROM app_sales_items i
          JOIN app_sales s ON s.id = i.sale_id
          WHERE s.business_id = $1
            AND (s.occurred_at AT TIME ZONE 'UTC')::date BETWEEN $2::date AND $3::date
            AND i.article_id IS NOT NULL
          GROUP BY 1,2,3
        )
        INSERT INTO sales_daily_items (business_id, articulo_id, "date", qty, amount)
        SELECT business_id, articulo_id, day, qty, amount
        FROM agg_items
        ON CONFLICT (business_id, articulo_id, "date")
        DO UPDATE SET qty    = EXCLUDED.qty,
                      amount = EXCLUDED.amount
        RETURNING 1
        `,
        [businessId, from, to]
      );

      details.push({ businessId, rows_items_upserted: r.rowCount });
    }

    res.json({ ok: true, from, to, count: details.length, details });
  } catch (e) {
    console.error('rebuild-sales-agg error', e);
    res.status(500).json({ error: 'internal', detail: e.message });
  }
});

module.exports = router;
