// services/salesStore.js
const pool = require('../config/db');

/**
 * Normaliza facturas crudas de Maxi a:
 * - app_sales (comprobante)
 * - app_sales_items (líneas)
 * y devuelve también días tocados para recalcular sales_daily.
 *
 * rawFacturas: array de objetos como vienen en /estadisticas/fullinvoicebydate
 */
function normalizeInvoices(businessId, rawFacturas) {
  const sales = [];
  const items = [];
  const touchedDays = new Set();

  for (const f of (rawFacturas || [])) {
    const cab = f?.factura?.cabecera || f?.cabecera || f || {};
    const lines = f?.factura?.items || f?.items || [];

    const extId =
      cab?.id || cab?.numero || cab?.nro || cab?.nroComprobante || cab?.nroFactura || cab?.idFactura;
    const occurredAt =
      cab?.fecha || cab?.fechaEmision || cab?.fechaDocumento || cab?.fechaFactura || cab?.createdAt;
    const total =
      cab?.total || cab?.importeTotal || cab?.monto || cab?.montoTotal || 0;

    if (!extId || !occurredAt) continue;

    const occurredIso = new Date(occurredAt).toISOString();
    const day = occurredIso.slice(0, 10);
    touchedDays.add(day);

    const sale = {
      business_id: businessId,
      external_id: String(extId),
      occurred_at: occurredIso,
      total: Number(total || 0),
      props: cab, // guardamos cabecera completa por si hace falta
    };
    sales.push(sale);

    let pos = 0;
    for (const it of (lines || [])) {
      pos++;
      const item = {
        sale_external_id: String(extId), // para mapear al id real luego
        line_pos: pos,
        article_id: it?.cod_art || it?.codigoArticulo || it?.articuloId || it?.idArticulo || null,
        sku: it?.codigo || it?.sku || null,
        name: it?.descripcion || it?.nombre || null,
        quantity: Number(it?.cantidad || it?.unidades || it?.qty || 0),
        unit_price: Number(it?.precio || it?.precioUnitario || it?.unitPrice || 0),
        total: Number(it?.total || it?.importe || it?.monto || 0),
        props: it || {},
      };
      items.push(item);
    }
  }
  return { sales, items, touchedDays: Array.from(touchedDays) };
}

/**
 * Inserta/actualiza lotes en app_sales/app_sales_items y recalcula sales_daily.
 * Idempotente por (business_id, external_id) y (sale_id, line_pos).
 */
async function upsertSalesBatch(businessId, rawFacturas) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { sales, items, touchedDays } = normalizeInvoices(businessId, rawFacturas);

    // 1) app_sales: upsert por (business_id, external_id)
    //    devolvemos (id, external_id) para mapear items.
    const salesIds = [];
    if (sales.length) {
      const values = [];
      const params = [];
      let p = 1;
      for (const s of sales) {
        params.push(s.business_id, s.external_id, s.occurred_at, s.total, s.props);
        values.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
      }
      const sql = `
        INSERT INTO app_sales (business_id, external_id, occurred_at, total, props)
        VALUES ${values.join(',')}
        ON CONFLICT (business_id, external_id)
        DO UPDATE SET
          occurred_at = EXCLUDED.occurred_at,
          total       = EXCLUDED.total,
          props       = EXCLUDED.props,
          updated_at  = now()
        RETURNING id, external_id, occurred_at;
      `;
      const { rows } = await client.query(sql, params);
      for (const r of rows) salesIds.push(r);
    }

    // Map extId -> sale_id para insertar items
    const idByExt = new Map(salesIds.map(r => [String(r.external_id), r.id]));

    // 2) app_sales_items: upsert por (sale_id, line_pos)
    if (items.length) {
      const values = [];
      const params = [];
      let p = 1;
      for (const it of items) {
        const saleId = idByExt.get(it.sale_external_id);
        if (!saleId) continue; // debería existir
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
            props      = EXCLUDED.props;
        `;
        await client.query(sql, params);
      }
    }

    // 3) Recalcular agregados sales_daily para los días tocados
    //    Sumamos totales y conteo de transacciones por day para este business.
    if (touchedDays.length) {
      // Traemos los comprobantes por día (solo del negocio y días tocados)
      const { rows } = await client.query(
        `
        SELECT DATE(occurred_at) AS day, SUM(total)::numeric(14,2) AS total, COUNT(*)::int AS tx_count
        FROM app_sales
        WHERE business_id = $1 AND DATE(occurred_at) = ANY($2::date[])
        GROUP BY 1
        `,
        [businessId, touchedDays]
      );

      // Upsert a sales_daily
      if (rows.length) {
        const values = [];
        const params = [];
        let p = 1;
        for (const r of rows) {
          params.push(businessId, r.day, r.total, r.tx_count);
          values.push(`($${p++}, $${p++}, $${p++}, $${p++})`);
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

    await client.query('COMMIT');
    return {
      upserted: sales.length,    // aproximación (nuevos/actualizados)
      updated: 0,                // si querés contar exacto, agrega RETURNING con flags
      minDay: touchedDays.length ? touchedDays.slice().sort()[0] : null,
      maxDay: touchedDays.length ? touchedDays.slice().sort().slice(-1)[0] : null,
    };
  } catch (e) {
    await client.query('ROLLBACK');
    e.status = e.status || 500;
    throw e;
  } finally {
    client.release();
  }
}

/** Lee la marca de última sync de ventas desde app_businesses.props */
async function getLastSalesSyncAt(businessId) {
  const { rows } = await pool.query(
    `SELECT (props->>'last_sales_sync_at') AS ts FROM app_businesses WHERE id=$1`,
    [businessId]
  );
  return rows[0]?.ts || null;
}

/** Setea la marca de última sync en app_businesses.props.last_sales_sync_at */
async function setLastSalesSyncAt(businessId, isoTs) {
  await pool.query(
    `
    UPDATE app_businesses
       SET props = COALESCE(props,'{}'::jsonb) || jsonb_build_object('last_sales_sync_at', $2::text)
     WHERE id = $1
    `,
    [businessId, isoTs]
  );
}

module.exports = { upsertSalesBatch, getLastSalesSyncAt, setLastSalesSyncAt };
