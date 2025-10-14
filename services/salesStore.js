// services/salesStore.js
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || undefined,
  ssl: (process.env.PGSSLMODE === 'disable') ? false : { rejectUnauthorized: false }
});

/**
 * Inserta/actualiza ventas (app_sales) e items (app_sales_items) en modo idempotente,
 * y recalcula sales_daily SOLO para el rango afectado.
 */
async function upsertSalesBatch(businessId, salesList = []) {
  if (!salesList.length) {
    return { minDay: null, maxDay: null, upserted: 0, updated: 0 };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let minDay = null, maxDay = null;
    let upserted = 0, updated = 0;

    for (const s of salesList) {
      const occurredAt = new Date(s.occurred_at);
      const dayStr = occurredAt.toISOString().slice(0,10);
      if (!minDay || dayStr < minDay) minDay = dayStr;
      if (!maxDay || dayStr > maxDay) maxDay = dayStr;

      const r = await client.query(
        `INSERT INTO app_sales (business_id, external_id, occurred_at, total, props)
         VALUES ($1, $2, $3, $4, COALESCE($5,'{}'::jsonb))
         ON CONFLICT (business_id, external_id)
         DO UPDATE SET
           occurred_at = EXCLUDED.occurred_at,
           total       = EXCLUDED.total,
           props       = app_sales.props || EXCLUDED.props,
           updated_at  = now()
         RETURNING id, (xmax = 0) AS inserted;`,
        [businessId, s.external_id, occurredAt.toISOString(), s.total ?? 0, s.props ?? {}]
      );
      const saleId = r.rows[0].id;
      if (r.rows[0].inserted) upserted++; else updated++;

      if (Array.isArray(s.items)) {
        for (const it of s.items) {
          await client.query(
            `INSERT INTO app_sales_items (sale_id, line_pos, article_id, sku, name, quantity, unit_price, total, props)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9,'{}'::jsonb))
             ON CONFLICT (sale_id, line_pos)
             DO UPDATE SET
               article_id = EXCLUDED.article_id,
               sku        = EXCLUDED.sku,
               name       = EXCLUDED.name,
               quantity   = EXCLUDED.quantity,
               unit_price = EXCLUDED.unit_price,
               total      = EXCLUDED.total,
               props      = app_sales_items.props || EXCLUDED.props;`,
            [
              saleId,
              it.line_pos ?? 0,
              it.article_id ?? null,
              it.sku ?? null,
              it.name ?? null,
              it.quantity ?? 0,
              it.unit_price ?? 0,
              it.total ?? 0,
              it.props ?? {}
            ]
          );
        }
      }
    }

    if (minDay && maxDay) {
      await client.query(
        `
        WITH d AS (
          SELECT
            business_id,
            (occurred_at AT TIME ZONE 'UTC')::date AS day,
            SUM(total)::numeric(14,2) AS total,
            COUNT(*)::int AS tx_count
          FROM app_sales
          WHERE business_id = $1
            AND (occurred_at AT TIME ZONE 'UTC')::date BETWEEN $2::date AND $3::date
          GROUP BY 1,2
        )
        INSERT INTO sales_daily (business_id, day, total, tx_count)
        SELECT business_id, day, total, tx_count
        FROM d
        ON CONFLICT (business_id, day)
        DO UPDATE SET total = EXCLUDED.total, tx_count = EXCLUDED.tx_count;
        `,
        [businessId, minDay, maxDay]
      );
    }

    await client.query('COMMIT');
    return { minDay, maxDay, upserted, updated };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function setLastSalesSyncAt(businessId, iso) {
  const sql = `
    UPDATE app_businesses
    SET props = jsonb_set(COALESCE(props,'{}'::jsonb), '{last_sales_sync_at}', to_jsonb($2::timestamptz), true)
    WHERE id = $1`;
  await pool.query(sql, [businessId, iso]);
}

async function getLastSalesSyncAt(businessId) {
  const { rows } = await pool.query(
    `SELECT (props->>'last_sales_sync_at')::timestamptz AS ts FROM app_businesses WHERE id=$1`,
    [businessId]
  );
  return rows[0]?.ts || null;
}

module.exports = {
  upsertSalesBatch,
  setLastSalesSyncAt,
  getLastSalesSyncAt,
};
