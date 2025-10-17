// services/salesStore.js
const pool = require('../config/db');

// ---------- helpers fecha ----------
const pad2 = n => String(n).padStart(2,'0');
const ymd  = d => `${d.getUTCFullYear()}-${pad2(d.getUTCMonth()+1)}-${pad2(d.getUTCDate())}`;

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

    // external id estable (preferimos numero; sino alguno de estos)
    const extId =
      cab?.id || cab?.numero || cab?.nro || cab?.nroComprobante || cab?.nroFactura || cab?.idFactura;

    // fecha puede venir en varios campos; parseamos robusto (DD/MM/YYYY)
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

      const lineTotal =
        it?.total ?? it?.importe ?? it?.monto ?? 0;

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

    // ... (INSERT app_sales / app_sales_items) igual que lo tenías ...

    // ⚠️ Agregado diario usando UTC para calzar con índice ix_app_sales_biz_day
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
          DO UPDATE SET total = EXCLUDED.total, tx_count = EXCLUDED.tx_count
          `,
          params
        );
      }
    }

    await client.query('COMMIT');
    return {
      upserted: sales.length,
      updated: 0,
      minDay: touchedDays.length ? [...touchedDays].sort()[0] : null,
      maxDay: touchedDays.length ? [...touchedDays].sort().slice(-1)[0] : null,
    };
  } catch (e) {
    await client.query('ROLLBACK');
    e.status = e.status || 500;
    throw e;
  } finally {
    client.release();
  }
}

async function getLastSalesSyncAt(businessId) { /* igual que ya tenías */ }
async function setLastSalesSyncAt(businessId, isoTs) { /* igual que ya tenías */ }

module.exports = {
  normalizeInvoices,
  upsertSalesBatch,
  getLastSalesSyncAt,
  setLastSalesSyncAt,
};
