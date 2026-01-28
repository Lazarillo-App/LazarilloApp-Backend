// services/salesDailyRebuildService.js
'use strict';

const pool = require('../config/db');

async function rebuildSalesDailyRange({ businessId, from, to, client = null }) {
  const bid = Number(businessId);
  if (!Number.isFinite(bid) || bid <= 0) throw new Error('businessId inválido');
  if (!from || !to) throw new Error('from/to requeridos (YYYY-MM-DD)');

  const q = (sql, params) => (client ? client.query(sql, params) : pool.query(sql, params));

  // 1) borrar rango (ventas agregadas)
  const del = await q(
    `
    DELETE FROM sales_daily
    WHERE business_id = $1
      AND day BETWEEN $2::date AND $3::date
    `,
    [bid, from, to]
  );

  // 2) recalcular desde items prefiriendo CSV sobre Maxi
  // Nota: tx_count acá NO son tickets reales; es conteo de filas "day+article" en el set preferido.
  const ins = await q(
    `
    WITH preferred AS (
      SELECT DISTINCT ON (business_id, day, article_id)
        business_id, day, article_id, amount
      FROM sales_daily_items
      WHERE business_id = $1
        AND day BETWEEN $2::date AND $3::date
        AND source IN ('csv','maxi')
      ORDER BY business_id, day, article_id,
               CASE WHEN source='csv' THEN 0 ELSE 1 END
    )
    INSERT INTO sales_daily (business_id, day, total, tx_count)
    SELECT
      business_id,
      day,
      SUM(amount)::numeric(14,2) AS total,
      COUNT(*)::int              AS tx_count
    FROM preferred
    GROUP BY business_id, day
    ON CONFLICT (business_id, day)
    DO UPDATE SET
      total = EXCLUDED.total,
      tx_count = EXCLUDED.tx_count
    `,
    [bid, from, to]
  );

  return {
    ok: true,
    deleted_days: del.rowCount || 0,
    upserted_days: ins.rowCount || 0,
    range: { from, to },
  };
}

module.exports = { rebuildSalesDailyRange };
