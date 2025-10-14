// services/salesStore.js
const pool = require('../config/db');

// ---------- helpers fecha ----------
const pad2 = n => String(n).padStart(2,'0');
const ymd  = d => `${d.getUTCFullYear()}-${pad2(d.getUTCMonth()+1)}-${pad2(d.getUTCDate())}`;

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

// ---------- normalización ----------
function buildExternalId(cab) {
  const tipo = String(cab?.tipo || cab?.tipoComprobante || 'DOC').trim();
  const pto  = String(cab?.puntoVenta || cab?.ptoVenta || '0').trim();
  const nro  = String(cab?.id || cab?.numero || cab?.nro || cab?.nroComprobante || cab?.nroFactura || cab?.idFactura || '0').trim();
  // external_id compuesto para idempotencia robusta
  return `${tipo}|${pto}|${nro}`;
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

  for (const f of (rawFacturas || [])) {
    const cab = f?.factura?.cabecera || f?.cabecera || f || {};
    const lines = f?.factura?.items || f?.items || [];

    const extIdRaw =
      cab?.id || cab?.numero || cab?.nro || cab?.nroComprobante || cab?.nroFactura || cab?.idFactura;
    const occurredAt =
      cab?.fecha || cab?.fechaEmision || cab?.fechaDocumento || cab?.fechaFactura || cab?.createdAt;

    if (!extIdRaw || !occurredAt) continue;

    // Fecha -> ISO UTC
    const dt = new Date(occurredAt);
    const occurredIso = new Date(Date.UTC(
      dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate(),
      dt.getUTCHours(), dt.getUTCMinutes(), dt.getUTCSeconds()
    )).toISOString();

    const day = occurredIso.slice(0, 10);
    touchedDays.add(day);

    // Total: NC en negativo si el tipo lo indica
    const rawTotal = cab?.total ?? cab?.importeTotal ?? cab?.monto ?? cab?.montoTotal ?? 0;
    const isNC = /nota.*cr[eé]dito|^nc$/i.test(String(cab?.tipo || cab?.tipoComprobante || ''));
    const total = Number(isNC ? -Math.abs(Number(rawTotal || 0)) : Number(rawTotal || 0));

    const sale = {
      business_id: businessId,
      external_id: buildExternalId({ ...cab, id: extIdRaw }),
      occurred_at: occurredIso,
      total,
      props: cab,
    };
    sales.push(sale);

    let pos = 0;
    for (const it of (lines || [])) {
      pos++;
      items.push({
        sale_external_id: sale.external_id, // mapearemos al id real tras el UPSERT
        line_pos: pos,
        article_id: it?.cod_art || it?.codigoArticulo || it?.articuloId || it?.idArticulo || null,
        sku: it?.codigo || it?.sku || null,
        name: it?.descripcion || it?.nombre || null,
        quantity: Number(it?.cantidad || it?.unidades || it?.qty || 0),
        unit_price: Number(it?.precio || it?.precioUnitario || it?.unitPrice || 0),
        total: Number(it?.total || it?.importe || it?.monto || 0),
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

    // 1) app_sales: UPSERT con flag inserted
    let salesIds = [];
    let upserted = 0, updated = 0;

    if (sales.length) {
      const cols = ['business_id','external_id','occurred_at','total','props'];
      const values = [];
      const params = [];
      let p = 1;
      for (const s of sales) {
        params.push(s.business_id, s.external_id, s.occurred_at, s.total, s.props);
        values.push(`($${p++},$${p++},$${p++},$${p++},$${p++})`);
      }
      const sql = `
        INSERT INTO app_sales (${cols.join(',')})
        VALUES ${values.join(',')}
        ON CONFLICT (business_id, external_id)
        DO UPDATE SET
          occurred_at = EXCLUDED.occurred_at,
          total       = EXCLUDED.total,
          props       = EXCLUDED.props,
          updated_at  = now()
        RETURNING (xmax = 0) AS inserted, id, external_id, occurred_at
      `;
      const { rows } = await client.query(sql, params);
      for (const r of rows) {
        if (r.inserted) upserted++; else updated++;
      }
      salesIds = rows.map(({ id, external_id }) => ({ id, external_id }));
    }

    // Map external_id -> sale_id
    const idByExt = new Map(salesIds.map(r => [String(r.external_id), r.id]));

    // 2) app_sales_items: UPSERT por (sale_id, line_pos)
    if (items.length) {
      const values = [];
      const params = [];
      let p = 1;
      for (const it of items) {
        const saleId = idByExt.get(it.sale_external_id);
        if (!saleId) continue;
        params.push(
          saleId, it.line_pos, it.article_id, it.sku, it.name,
          it.quantity, it.unit_price, it.total, it.props
        );
        values.push(
          `($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++})`
        );
      }
      if (values.length) {
        const sql = `
          INSERT INTO app_sales_items
            (sale_id, line_pos, article_id, sku, name, quantity, unit_price, total, props)
          VALUES ${values.join(',')}
          ON CONFLICT (sale_id, line_pos)
          DO UPDATE SET
            article_id = EXCLUDED.article_id,
            sku        = EXCLUDED.sku,
            name       = EXCLUDED.name,
            quantity   = EXCLUDED.quantity,
            unit_price = EXCLUDED.unit_price,
            total      = EXCLUDED.total,
            props      = EXCLUDED.props
        `;
        await client.query(sql, params);
      }
    }

    // 3) Recalcular agregados sales_daily para días tocados
    if (touchedDays.length) {
      const { rows } = await client.query(
        `
        SELECT DATE(occurred_at) AS day,
               SUM(total)::numeric(14,2) AS total,
               COUNT(*)::int            AS tx_count
          FROM app_sales
         WHERE business_id = $1
           AND DATE(occurred_at) = ANY($2::date[])
         GROUP BY 1
        `,
        [businessId, touchedDays]
      );

      if (rows.length) {
        const values = [];
        const params = [];
        let p = 1;
        for (const r of rows) {
          params.push(businessId, r.day, r.total, r.tx_count);
          values.push(`($${p++},$${p++},$${p++},$${p++})`);
        }
        await client.query(
          `
          INSERT INTO sales_daily (business_id, day, total, tx_count)
          VALUES ${values.join(',')}
          ON CONFLICT (business_id, day)
          DO UPDATE SET
            total    = EXCLUDED.total,
            tx_count = EXCLUDED.tx_count
          `,
          params
        );
      }
    }

    // Intervalo tocado (para logging)
    const minDay = touchedDays.length ? [...touchedDays].sort()[0] : null;
    const maxDay = touchedDays.length ? [...touchedDays].sort().slice(-1)[0] : null;

    await client.query('COMMIT');
    return { upserted, updated, minDay, maxDay };
  } catch (e) {
    await client.query('ROLLBACK');
    e.status = e.status || 500;
    throw e;
  } finally {
    client.release();
  }
}

module.exports = {
  normalizeInvoices, // si lo querés testear
  upsertSalesBatch,
  getLastSalesSyncAt,
  setLastSalesSyncAt,
};
