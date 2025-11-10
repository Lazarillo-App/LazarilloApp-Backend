// services/salesStore.js
const pool = require('../config/db');

/* ───────── helpers num/date ───────── */
const toNum = (v) => {
  if (v == null || v === '') return 0;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
};

function parseYMDorDMYtoUTC(dateStr) {
  if (!dateStr) return null;
  // Casos típicos:
  // - "2025-11-03"
  // - "03/11/2025"
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return new Date(`${dateStr}T00:00:00Z`);
  }
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(dateStr);
  if (m) {
    const [_, dd, mm, yyyy] = m;
    return new Date(`${yyyy}-${mm}-${dd}T00:00:00Z`);
  }
  // fallback
  const d = new Date(dateStr);
  return Number.isFinite(+d) ? new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())) : null;
}

/* 
   Normaliza ambos formatos:
   - fullinvoicebydate: { factura: { numero, total, cabecera{ fecha, ... }, items[] } }
   - invoicebydate:     { order: { orderData{ orderId, orderDate, totalSales }, orderItems:[{ orderItem{ title, quantity, productPrice, totalPrice, ... } }] } }
*/
function normalizeInvoices(businessId, rawDocs) {
  const sales = [];
  const items = [];
  const touchedDays = new Set();

  const pushSale = (external_id, occurred_at, total) => {
    const s = { business_id: businessId, external_id, occurred_at, total: toNum(total) };
    sales.push(s);
    touchedDays.add(s.occurred_at.toISOString().slice(0,10)); // YYYY-MM-DD
    return s;
  };

  const pushItem = (sale_idx, line_pos, data) => {
    // data: { article_id?, article_name, qty, unit_price, line_total }
    items.push({
      business_id: businessId,
      sale_idx,
      line_pos,
      article_id: data.article_id ?? null,         // si tu pipeline resuelve ID en otro paso, dejalo null
      article_name: data.article_name || null,     // útil para joins posteriores
      qty: toNum(data.qty),
      unit_price: toNum(data.unit_price),
      line_total: toNum(data.line_total),
    });
  };

  (rawDocs || []).forEach((doc) => {
    // ───────── fullinvoicebydate ─────────
    if (doc && doc.numero && (doc.cabecera || doc.items)) {
      const external = String(doc.numero);
      const occurred = parseYMDorDMYtoUTC(doc.cabecera?.fecha || doc.fecha);
      const total    = toNum(doc.total);

      const sale_idx = sales.length;
      pushSale(external, occurred, total);

      (doc.items || []).forEach((it, i) => {
        const nombre   = it.nombre_art || it.title || it.descripcion || 'Item';
        const cantidad = toNum(it.cantidad);
        const precio   = toNum(it.precio);
        // Para fullinvoice no viene total por línea → lo calculamos
        const lineTotal = toNum(it.total) || (cantidad * precio);

        pushItem(sale_idx, i + 1, {
          article_id: it.cod_art ?? null,
          article_name: nombre,
          qty: cantidad,
          unit_price: precio,
          line_total: lineTotal,
        });
      });
      return;
    }

    // ───────── invoicebydate (ordenes) ─────────
    const ord = doc?.order;
    if (ord?.orderData) {
      const od  = ord.orderData;
      const oid = od.orderId ? String(od.orderId) : null;
      const occurred = parseYMDorDMYtoUTC(od.orderDate || od.date);
      const total    = toNum(od.totalSales);

      const sale_idx = sales.length;
      pushSale(oid, occurred, total);

      const arr = Array.isArray(ord.orderItems) ? ord.orderItems : [];
      arr.forEach((wrap, i) => {
        const oi = wrap?.orderItem || wrap || {};
        const title   = oi.title || oi.nombre_art || 'Item';
        const qty     = toNum(oi.quantity);
        const price   = toNum(oi.productPrice);
        // Clave del bug: si totalPrice viene 0 o ausente, calcular qty*price
        const lineTot = toNum(oi.totalPrice) || (qty * price);

        // Si tu pipeline resuelve artículo, dejá article_id en null y conservá el nombre
        pushItem(sale_idx, i + 1, {
          article_id: oi.cod_art ?? null,
          article_name: title,
          qty,
          unit_price: price,
          line_total: lineTot,
        });
      });
      return;
    }

    // Si viene otro objeto raro, lo ignoramos para no romper
  });

  return { sales, items, touchedDays: Array.from(touchedDays) };
}

/**
 * Inserta/actualiza ventas e ítems y recalcula agregados diarios SOLO para los días tocados.
 * Devuelve { upserted, updated, minDay, maxDay }
 */
async function upsertSalesBatch(businessId, rawDocs, clientExtern = null) {
  const { sales, items, touchedDays } = normalizeInvoices(businessId, rawDocs);
  if (!sales.length) return { upserted: 0, updated: 0, minDay: null, maxDay: null };

  const client = clientExtern || await pool.connect();
  try {
    await client.query('BEGIN');

    // 1) UPSERT app_sales y quedarnos con los IDs (por external_id)
    const saleIdMap = new Map(); // sale_idx -> sale_id
    let upserted = 0, updated = 0;

    for (let i = 0; i < sales.length; i++) {
      const s = sales[i];
      const { rows } = await client.query(
        `INSERT INTO app_sales (business_id, external_id, occurred_at, total)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (business_id, external_id)
         DO UPDATE SET total = EXCLUDED.total
         RETURNING id, (xmax = 0) AS inserted`,
        [s.business_id, s.external_id, s.occurred_at, s.total]
      );
      saleIdMap.set(i, rows[0].id);
      if (rows[0].inserted) upserted++; else updated++;
    }

    // 2) Reemplazamos líneas por venta (simple y seguro para mantener consistencia)
    //    (Si querés micro-diff, lo podemos hacer después)
    //    Armamos bulk insert con VALUES
    if (items.length) {
      // Borramos líneas previas de estas ventas
      const saleIds = Array.from(saleIdMap.values());
      await client.query(
        `DELETE FROM app_sales_items WHERE sale_id = ANY($1::int[])`,
        [saleIds]
      );

      const values = [];
      const params = [];
      let p = 1;
      items.forEach((it) => {
        const sale_id = saleIdMap.get(it.sale_idx);
        if (!sale_id) return;
        values.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
        params.push(
          sale_id,
          it.line_pos,
          it.article_id,
          it.article_name,
          it.qty,
          it.line_total // 🔴 usamos line_total para el monto de la línea
        );
      });

      if (values.length) {
        await client.query(
          `INSERT INTO app_sales_items (sale_id, line_pos, article_id, article_name, qty, amount)
           VALUES ${values.join(',')}`,
          params
        );
      }
    }

    // 3) Recalcular agregados para los días tocados
    if (touchedDays.length) {
      // Normalizamos a array único de días YYYY-MM-DD
      const days = touchedDays.sort();
      const minDay = days[0];
      const maxDay = days[days.length - 1];

      // Borrado selectivo
      await client.query(
        `DELETE FROM sales_daily
          WHERE business_id = $1 AND day = ANY($2::date[])`,
        [businessId, days]
      );
      await client.query(
        `DELETE FROM sales_daily_items
          WHERE business_id = $1 AND day = ANY($2::date[])`,
        [businessId, days]
      );

      // sales_daily: suma de totales y tx_count
      await client.query(
        `INSERT INTO sales_daily (business_id, day, total, tx_count)
         SELECT s.business_id,
                (s.occurred_at AT TIME ZONE 'UTC')::date AS day,
                SUM(s.total) AS total,
                COUNT(*)     AS tx_count
         FROM app_sales s
         WHERE s.business_id = $1
           AND (s.occurred_at AT TIME ZONE 'UTC')::date = ANY($2::date[])
         GROUP BY s.business_id, day`,
        [businessId, days]
      );

      // sales_daily_items: suma por artículo del amount de la línea (NO unit_price)
      await client.query(
        `INSERT INTO sales_daily_items (business_id, day, article_id, qty, amount)
         SELECT s.business_id,
                (s.occurred_at AT TIME ZONE 'UTC')::date AS day,
                si.article_id,
                SUM(si.qty)    AS qty,
                SUM(si.amount) AS amount
         FROM app_sales_items si
         JOIN app_sales s ON s.id = si.sale_id
         WHERE s.business_id = $1
           AND (s.occurred_at AT TIME ZONE 'UTC')::date = ANY($2::date[])
         GROUP BY s.business_id, day, si.article_id`,
        [businessId, days]
      );

      await client.query('COMMIT');
      return { upserted, updated, minDay, maxDay };
    }

    await client.query('COMMIT');
    return { upserted, updated, minDay: null, maxDay: null };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    if (!clientExtern) client.release();
  }
}

module.exports = {
  normalizeInvoices,
  upsertSalesBatch,
};

