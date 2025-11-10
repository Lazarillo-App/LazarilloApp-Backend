const pool = require('../config/db');

// ---------- helpers fecha ----------
const pad2 = n => String(n).padStart(2, '0');
const ymd = d => `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;

function parseMaxiDate(value) {
  if (!value) return null;
  if (value instanceof Date && !isNaN(+value)) return value;
  if (typeof value === 'string') {
    // Ej: "07/08/2025" o "07/08/2025 14:33:10"
    const m = value.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/);
    if (m) {
      const dd = +m[1], mm = +m[2], yyyy = +m[3];
      const HH = +(m[4] ?? 0), MI = +(m[5] ?? 0), SS = +(m[6] ?? 0);
      return new Date(Date.UTC(yyyy, mm - 1, dd, HH, MI, SS));
    }
  }
  const d = new Date(value);
  return isNaN(+d) ? null : d;
}

// ---------- props.last_sales_sync_at ----------
async function getLastSalesSyncAt(businessId) {
  const { rows } = await pool.query(
    `SELECT (props->>'last_sales_sync_at') AS ts
       FROM app_businesses
      WHERE id=$1`,
    [businessId]
  );
  return rows[0]?.ts || null;
}

async function setLastSalesSyncAt(businessId, isoTs) {
  await pool.query(
    `UPDATE app_businesses
        SET props = COALESCE(props,'{}'::jsonb) || jsonb_build_object('last_sales_sync_at', $2::text)
      WHERE id = $1`,
    [businessId, isoTs]
  );
}

/**
 * Normaliza facturas crudas de Maxi a:
 *  - app_sales (comprobante)
 *  - app_sales_items (líneas)
 *  y devuelve días tocados para recalcular sales_daily.
 */
function normalizeInvoices(businessId, rawFacturas = []) {
  const sales = [];
  const items = [];
  const touchedDays = new Set();

  const toISODate = (dmy) => {
    if (!dmy) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(dmy)) return dmy;
    const m = String(dmy).match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (m) {
      const [_, dd, mm, yyyy] = m;
      return `${yyyy}-${mm}-${dd}`;
    }
    return null;
  };

  const pushSale = ({ external_id, occurred_at, total, raw }) => {
    if (!external_id) return null;
    const occurredISO = occurred_at ? new Date(`${occurred_at}T00:00:00.000Z`).toISOString() : null;
    sales.push({
      business_id: businessId,
      external_id,
      occurred_at: occurredISO,
      total: Number(total || 0),
      raw
    });
    if (occurred_at) touchedDays.add(occurred_at);
    return sales.length - 1;
  };

  for (const row of rawFacturas) {
    // ───────── fullinvoicebydate ─────────
    if (row?.factura) {
      const f = row.factura;
      const fechaYMD = toISODate(f.fecha || f.cabecera?.fecha);
      const total    = Number(f.total ?? f.cabecera?.total ?? 0) || 0;
      const external = String(f.numero || `${f.cabecera?.prefijo || ''}-${f.cabecera?.numero || ''}`).trim() || null;

      const saleIdx = pushSale({
        external_id: external,
        occurred_at: fechaYMD,
        total,
        raw: f
      });

      if (saleIdx != null && Array.isArray(f.items)) {
        let pos = 0;
        for (const it of f.items) {
          items.push({
            business_id: businessId,
            sale_index: saleIdx,
            line_pos: pos++,
            cod_art: Number(it.cod_art ?? 0) || null,
            nombre_art: String(it.nombre_art ?? '').trim() || null,
            cantidad: Number(it.cantidad ?? 0) || 0,
            precio_unit: Number(it.precio ?? 0) || 0,
            total_line: Number(it.cantidad ?? 0) * Number(it.precio ?? 0) || 0,
            raw: it
          });
        }
      }
      continue;
    }

    // ───────── invoicebydate ─────────
    const od = row?.order?.orderData || row?.orderData || null;
    if (od) {
      const fechaYMD = toISODate(od.orderDate);
      const total    = Number(od.totalSales ?? 0) || 0;
      const external = String(od.orderId || '').trim() || null;

      const saleIdx = pushSale({
        external_id: external,
        occurred_at: fechaYMD,
        total,
        raw: row.order || row
      });

      const orderItems = row?.order?.orderItems || row?.orderItems || [];
      if (saleIdx != null && Array.isArray(orderItems)) {
        let pos = 0;
        for (const wrapper of orderItems) {
          const it = wrapper?.orderItem || wrapper || {};
          const qty   = Number(it.quantity ?? 0) || 0;
          const pu    = Number(it.productPrice ?? 0) || 0;
          const tline = Number(it.totalPrice ?? (qty * pu)) || 0;
          items.push({
            business_id: businessId,
            sale_index: saleIdx,
            line_pos: pos++,
            cod_art: null, // no viene código en este endpoint
            nombre_art: String(it.title ?? '').trim() || null,
            cantidad: qty,
            precio_unit: pu,
            total_line: tline,
            raw: it
          });
        }
      }
      continue;
    }

    // Si llega algo desconocido, lo ignoramos (pero podríamos loguearlo)
  }

  return { sales, items, touchedDays: Array.from(touchedDays) };
}

/**
 * Inserta/actualiza lotes en app_sales/app_sales_items y recalcula sales_daily.
 * Idempotente por (business_id, external_id) y (sale_id, line_pos).
 * Devuelve conteos reales: { upserted, updated, minDay, maxDay }
 */
async function upsertSalesBatch(businessId, rawFacturas) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1) Normalizar payload a { sales, items, touchedDays }
    const { sales, items, touchedDays } = normalizeInvoices(businessId, rawFacturas);

    if (!sales.length && !items.length) {
      await client.query('COMMIT');
      return { upserted: 0, updated: 0, minDay: null, maxDay: null };
    }

    // 2) UPSERT app_sales — idempotente por (business_id, external_id)
    let externalToId = new Map();

    if (sales.length) {
      const bizArr   = sales.map(s => Number(s.business_id));
      const extArr   = sales.map(s => String(s.external_id));
      const atArr    = sales.map(s => new Date(s.occurred_at));       // timestamptz[]
      const totArr   = sales.map(s => Number(s.total || 0));          // numeric[]
      const propsArr = sales.map(s => s.props || {});                 // jsonb[]

      const qSales = `
        WITH up AS (
          INSERT INTO app_sales (business_id, external_id, occurred_at, total, props)
          SELECT * FROM UNNEST(
            $1::bigint[],  -- business_id
            $2::text[],    -- external_id
            $3::timestamptz[], -- occurred_at
            $4::numeric[], -- total
            $5::jsonb[]    -- props
          )
          ON CONFLICT (business_id, external_id)
          DO UPDATE SET occurred_at = EXCLUDED.occurred_at,
                        total       = EXCLUDED.total,
                        props       = EXCLUDED.props
          RETURNING id, external_id
        )
        SELECT id, external_id FROM up
      `;
      const r = await client.query(qSales, [bizArr, extArr, atArr, totArr, propsArr]);
      externalToId = new Map(r.rows.map(x => [String(x.external_id), Number(x.id)]));
    }

    // 3) UPSERT app_sales_items — idempotente por (sale_id, line_pos)
    if (items.length) {
      const saleIdArr = [];
      const posArr    = [];
      const artArr    = [];
      const skuArr    = [];
      const nameArr   = [];
      const qtyArr    = [];
      const unitArr   = [];
      const lineTot   = [];
      const propsArr  = [];

      for (const it of items) {
        const saleId = externalToId.get(String(it.sale_external_id));
        if (!saleId) continue; // si no insertó/actualizó el comprobante, saltamos la línea
        saleIdArr.push(Number(saleId));
        posArr.push(Number(it.line_pos));
        artArr.push(it.article_id != null ? Number(it.article_id) : null); // puede ser NULL
        skuArr.push(it.sku != null ? String(it.sku) : null);
        nameArr.push(it.name != null ? String(it.name) : null);
        qtyArr.push(Number(it.quantity || 0));
        unitArr.push(Number(it.unit_price || 0));
        lineTot.push(Number(it.total || 0));
        propsArr.push(it.props || {});
      }

      if (saleIdArr.length) {
        const qItems = `
          INSERT INTO app_sales_items
            (sale_id, line_pos, article_id, sku, name, quantity, unit_price, total, props)
          SELECT * FROM UNNEST(
            $1::bigint[],   -- sale_id
            $2::int[],      -- line_pos
            $3::int[],      -- article_id (NULL permitido)
            $4::text[],     -- sku
            $5::text[],     -- name
            $6::numeric[],  -- quantity
            $7::numeric[],  -- unit_price
            $8::numeric[],  -- total
            $9::jsonb[]     -- props
          )
          ON CONFLICT (sale_id, line_pos)
          DO UPDATE SET article_id = EXCLUDED.article_id,
                        sku        = EXCLUDED.sku,
                        name       = EXCLUDED.name,
                        quantity   = EXCLUDED.quantity,
                        unit_price = EXCLUDED.unit_price,
                        total      = EXCLUDED.total,
                        props      = EXCLUDED.props
        `;
        await client.query(qItems, [
          saleIdArr, posArr, artArr, skuArr, nameArr, qtyArr, unitArr, lineTot, propsArr
        ]);
      }
    }

    // 4) Recalcular sales_daily (por día) para los días tocados
    if (touchedDays.length) {
      const { rows } = await client.query(
        `
        SELECT (occurred_at AT TIME ZONE 'UTC')::date AS day,
               SUM(total)::numeric(14,2)            AS total,
               COUNT(*)::int                         AS tx_count
          FROM app_sales
         WHERE business_id = $1
           AND (occurred_at AT TIME ZONE 'UTC')::date = ANY($2::date[])
         GROUP BY 1
        `,
        [businessId, touchedDays]
      );

      if (rows.length) {
        const bizArr = rows.map(() => Number(businessId));
        const dayArr = rows.map(r => r.day);
        const totArr = rows.map(r => Number(r.total || 0));
        const txcArr = rows.map(r => Number(r.tx_count || 0));

        await client.query(
          `
          INSERT INTO sales_daily (business_id, day, total, tx_count)
          SELECT * FROM UNNEST(
            $1::bigint[],  -- business_id
            $2::date[],    -- day
            $3::numeric[], -- total
            $4::int[]      -- tx_count
          )
          ON CONFLICT (business_id, day)
          DO UPDATE SET total    = EXCLUDED.total,
                        tx_count = EXCLUDED.tx_count
          `,
          [bizArr, dayArr, totArr, txcArr]
        );
      }
    }

    // 5) Recalcular sales_daily_items (por artículo y día) para los días tocados
    if (touchedDays.length) {
      const { rows } = await client.query(
        `
        SELECT
          (s.occurred_at AT TIME ZONE 'UTC')::date AS date,
          i.article_id                             AS articulo_id,
          SUM(i.quantity)::numeric(14,3)          AS qty,
          SUM(i.total)::numeric(14,2)             AS amount
        FROM app_sales_items i
        JOIN app_sales s ON s.id = i.sale_id
        WHERE s.business_id = $1
          AND (s.occurred_at AT TIME ZONE 'UTC')::date = ANY($2::date[])
          AND i.article_id IS NOT NULL
        GROUP BY 1, 2
        ORDER BY 1, 2
        `,
        [businessId, touchedDays]
      );

      if (rows.length) {
        const bizArr  = rows.map(() => Number(businessId));
        const artArr  = rows.map(r => Number(r.articulo_id));
        const dateArr = rows.map(r => r.date);
        const qtyArr  = rows.map(r => Number(r.qty || 0));
        const amtArr  = rows.map(r => Number(r.amount || 0));

        await client.query(
          `
          INSERT INTO sales_daily_items (business_id, articulo_id, "date", qty, amount)
          SELECT * FROM UNNEST(
            $1::bigint[],  -- business_id
            $2::int[],     -- articulo_id
            $3::date[],    -- date
            $4::numeric[], -- qty
            $5::numeric[]  -- amount
          )
          ON CONFLICT (business_id, articulo_id, "date")
          DO UPDATE SET
            qty    = EXCLUDED.qty,
            amount = EXCLUDED.amount
          `,
          [bizArr, artArr, dateArr, qtyArr, amtArr]
        );
      }
    }

    await client.query('COMMIT');

    const sorted = Array.from(new Set(touchedDays)).sort();
    return {
      upserted: sales.length,
      updated: 0,
      minDay: sorted[0] || null,
      maxDay: sorted[sorted.length - 1] || null,
    };
  } catch (e) {
    await client.query('ROLLBACK');
    e.status = e.status || 500;
    throw e;
  } finally {
    client.release();
  }
}

module.exports = {
  normalizeInvoices,
  upsertSalesBatch,
  getLastSalesSyncAt,
  setLastSalesSyncAt,
};
