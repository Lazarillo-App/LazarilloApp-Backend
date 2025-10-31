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
function normalizeInvoices(businessId, rawFacturas) {
  const sales = [];
  const items = [];
  const touchedDays = new Set();

  // Aplana si vienen como { factura: {...} }
  const facturas = (rawFacturas || []).map(f => (f && f.factura) ? f.factura : f).filter(Boolean);

  for (const f of facturas) {
    const cab = f?.cabecera || f?.header || f || {};
    // Maxi suele usar "detalle" para renglones; mantenemos compat con "items"
    const lines = f?.detalle || f?.items || [];

    const baseExt =
      cab?.id || cab?.numero || cab?.nro || cab?.nroComprobante || cab?.nroFactura || cab?.idFactura;

    // preferir numero "0016-00001527" si viene, sino prefijo+numero
    let composed = null;
    if (typeof cab?.numero === 'string' && cab.numero.includes('-')) {
      composed = cab.numero;
    } else if (cab?.prefijo != null && cab?.numero != null) {
      composed = `P${cab.prefijo}-N${cab.numero}`;
    }

    const extId = composed || baseExt;

    // fecha robusta
    const occurredRaw =
      cab?.fecha || cab?.fechaEmision || cab?.fechaDocumento || cab?.fechaFactura || cab?.createdAt;
    const occurredDate = parseMaxiDate(occurredRaw);

    const total =
      cab?.total ?? cab?.importeTotal ?? cab?.monto ?? cab?.montoTotal ?? 0;

    if (!extId || !occurredDate) {
      // sin id o fecha válida, no insertamos este comprobante
      continue;
    }

    const occurredIso = occurredDate.toISOString();
    const day = occurredIso.slice(0, 10);
    touchedDays.add(day);

    sales.push({
      business_id: businessId,
      external_id: String(extId),
      occurred_at: occurredIso,
      total: Number(total || 0),
      props: cab, // guardamos cabecera completa
    });

    // map de campos comunes para líneas
    let pos = 0;
    for (const it of (Array.isArray(lines) ? lines : [])) {
      pos++;
      const articleId =
        it?.cod_art ?? it?.codigoArticulo ?? it?.articuloId ?? it?.idArticulo ?? null;

      const qty =
        it?.cantidad ?? it?.unidades ?? it?.qty ?? it?.cantidadVendida ?? 0;

      const unitPrice =
        it?.precio ?? it?.precioUnitario ?? it?.unitPrice ?? 0;

      const lineTotalRaw =
        it?.total ?? it?.importe ?? it?.monto ?? null;
      const lineTotal = lineTotalRaw != null
        ? lineTotalRaw
        : Number(qty || 0) * Number(unitPrice || 0);

      items.push({
        sale_external_id: String(extId),     // luego se mapea al id real con RETURNING
        line_pos: pos,
        article_id: articleId ? Number(articleId) : null,
        sku: it?.codigo || it?.sku || null,
        name: it?.descripcion || it?.nombre || null,
        quantity: Number(qty || 0),
        unit_price: Number(unitPrice || 0),
        total: Number(lineTotal || 0),
        props: it || {},
      });
    }
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

    const { sales, items, touchedDays } = normalizeInvoices(businessId, rawFacturas);
    if (!sales.length && !items.length) {
      await client.query('COMMIT');
      return { upserted: 0, updated: 0, minDay: null, maxDay: null };
    }

    // ---------- UPSERT app_sales (batch con UNNEST) ----------
    let externalToId = new Map();

    if (sales.length) {
      const bizArr = sales.map(s => s.business_id);
      const extArr = sales.map(s => s.external_id);
      const atArr = sales.map(s => new Date(s.occurred_at));
      const totArr = sales.map(s => Number(s.total || 0));
      const propsArr = sales.map(s => s.props || {});

      const qSales = `
      WITH up AS (
        INSERT INTO app_sales (business_id, external_id, occurred_at, total, props)
        SELECT * FROM UNNEST(
          $1::int[], $2::text[], $3::timestamptz[], $4::numeric[], $5::jsonb[]
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
      externalToId = new Map(r.rows.map(r => [String(r.external_id), Number(r.id)]));
    }

    // ---------- UPSERT app_sales_items (batch) ----------
    if (items.length) {
      // mapear sale_id desde sale_external_id
      const saleIdArr = [];
      const posArr = [];
      const artArr = [];
      const skuArr = [];
      const nameArr = [];
      const qtyArr = [];
      const unitArr = [];
      const lineTot = [];
      const propsArr = [];

      for (const it of items) {
        const saleId = externalToId.get(String(it.sale_external_id));
        if (!saleId) continue; // si no existe, saltamos
        saleIdArr.push(saleId);
        posArr.push(it.line_pos);
        artArr.push(it.article_id);
        skuArr.push(it.sku || null);
        nameArr.push(it.name || null);
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
          $1::int[], $2::int[], $3::int[], $4::text[], $5::text[],
          $6::numeric[], $7::numeric[], $8::numeric[], $9::jsonb[]
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

    // ---------- Recalcular sales_daily para días tocados ----------
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
        const bizArr = rows.map(r => businessId);
        const dayArr = rows.map(r => r.day);
        const totArr = rows.map(r => r.total);
        const txcArr = rows.map(r => r.tx_count);

        await client.query(
          `
          INSERT INTO sales_daily (business_id, day, total, tx_count)
          SELECT * FROM UNNEST($1::int[], $2::date[], $3::numeric[], $4::int[])
          ON CONFLICT (business_id, day)
          DO UPDATE SET total = EXCLUDED.total, tx_count = EXCLUDED.tx_count
          `,
          [bizArr, dayArr, totArr, txcArr]
        );
      }
    }
    // ---------- Recalcular sales_daily_items para días tocados ----------
    if (touchedDays.length) {
      const { rows: itemAgg } = await client.query(
        `
    SELECT
      (s.occurred_at AT TIME ZONE 'UTC')::date AS day,
      i.article_id                              AS articulo_id,
      SUM(i.quantity)::numeric(14,3)            AS qty,
      SUM(i.total)::numeric(14,2)               AS amount
    FROM app_sales_items i
    JOIN app_sales       s ON s.id = i.sale_id
    WHERE s.business_id = $1
      AND (s.occurred_at AT TIME ZONE 'UTC')::date = ANY($2::date[])
      AND i.article_id IS NOT NULL
    GROUP BY 1, 2
    ORDER BY 1, 2
    `,
        [businessId, touchedDays]
      );

      if (itemAgg.length) {
        const bizArr = itemAgg.map(() => businessId);
        const artArr = itemAgg.map(r => Number(r.articulo_id));
        const dayArr = itemAgg.map(r => r.day);
        const qtyArr = itemAgg.map(r => Number(r.qty || 0));
        const amtArr = itemAgg.map(r => Number(r.amount || 0));

        await client.query(
          `
      INSERT INTO sales_daily_items (business_id, articulo_id, "date", qty, amount)
      SELECT * FROM UNNEST(
        $1::int[], $2::int[], $3::date[], $4::numeric[], $5::numeric[]
      )
      ON CONFLICT (business_id, articulo_id, "date")
      DO UPDATE SET
        qty    = EXCLUDED.qty,
        amount = EXCLUDED.amount
      `,
          [bizArr, artArr, dayArr, qtyArr, amtArr]
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
