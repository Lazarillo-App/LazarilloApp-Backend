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
  // "2025-11-03"
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return new Date(`${dateStr}T00:00:00Z`);
  }
  // "03/11/2025"
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(dateStr);
  if (m) {
    const [_, dd, mm, yyyy] = m;
    return new Date(`${yyyy}-${mm}-${dd}T00:00:00Z`);
  }
  // fallback
  const d = new Date(dateStr);
  return Number.isFinite(+d)
    ? new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
    : null;
}

/*
  Normaliza ambos formatos:
  - fullinvoicebydate:
    { numero, total, cabecera{ fecha }, items:[{ nombre_art, cantidad, precio, total, cod_art? }] }

  - invoicebydate:
    { order:{ orderData{ orderId, orderDate, totalSales },
              orderItems:[{ orderItem{ title, quantity, productPrice, totalPrice, cod_art? } }] } }
*/
function normalizeInvoices(businessId, rawDocs) {
  const sales = [];
  const items = [];
  const touchedDays = new Set();

  const pushSale = (external_id, occurred_at, total) => {
    const s = { business_id: businessId, external_id, occurred_at, total: toNum(total) };
    sales.push(s);
    touchedDays.add(s.occurred_at.toISOString().slice(0, 10)); // YYYY-MM-DD
    return s;
  };

  const pushItem = (sale_idx, line_pos, data) => {
    items.push({
      business_id: businessId,
      sale_idx,
      line_pos,
      article_id: data.article_id ?? null,
      sku: data.sku ?? null,
      name: data.article_name || null,
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
      const total = toNum(doc.total);
      const sale_idx = sales.length;
      pushSale(external, occurred, total);

      (doc.items || []).forEach((it, i) => {
        const nombre = it.nombre_art || it.title || it.descripcion || 'Item';
        const cantidad = toNum(it.cantidad);
        const precio = toNum(it.precio);
        const lineTotal = toNum(it.total) || (cantidad * precio);

        pushItem(sale_idx, i + 1, {
          article_id: it.cod_art ?? null,
          sku: it.cod_art ? String(it.cod_art) : null,
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
      const od = ord.orderData;
      const oid = od.orderId ? String(od.orderId) : null;
      const occurred = parseYMDorDMYtoUTC(od.orderDate || od.date);
      const total = toNum(od.totalSales);
      const sale_idx = sales.length;
      pushSale(oid, occurred, total);

      const arr = Array.isArray(ord.orderItems) ? ord.orderItems : [];
      arr.forEach((wrap, i) => {
        const oi = wrap?.orderItem || wrap || {};
        const title = oi.title || oi.nombre_art || 'Item';
        const qty = toNum(oi.quantity);
        const price = toNum(oi.productPrice);
        const lineTot = toNum(oi.totalPrice) || (qty * price);

        pushItem(sale_idx, i + 1, {
          article_id: oi.cod_art ?? null,
          sku: oi.cod_art ? String(oi.cod_art) : null,
          article_name: title,
          qty,
          unit_price: price,
          line_total: lineTot,
        });
      });
      return;
    }

    // Otros formatos desconocidos se ignoran de forma segura
  });

  return { sales, items, touchedDays: Array.from(touchedDays) };
}

/**
 * Inserta/actualiza ventas e ítems, hace un mapeo por nombre exacto (con unaccent)
 * y recalcula agregados diarios SOLO para los días tocados.
 */
async function upsertSalesBatch(businessId, rawDocs, clientExtern = null) {
  const { sales, items, touchedDays } = normalizeInvoices(businessId, rawDocs);
  if (!sales.length) return { upserted: 0, updated: 0, minDay: null, maxDay: null };

  const client = clientExtern || await pool.connect();
  try {
    await client.query('BEGIN');

    // 1) UPSERT app_sales (clave: business_id + external_id)
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

    // 2) Reemplazar líneas por venta (consistencia simple)
    if (items.length) {
      const saleIds = Array.from(saleIdMap.values());
      if (saleIds.length) {
        await client.query(
          `DELETE FROM app_sales_items WHERE sale_id = ANY($1::int[])`,
          [saleIds]
        );
      }

      const values = [];
      const params = [];
      let p = 1;
      items.forEach((it) => {
        const sale_id = saleIdMap.get(it.sale_idx);
        if (!sale_id) return;
        values.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
        params.push(
          sale_id,                      // sale_id
          it.line_pos,                  // line_pos
          it.article_id,                // article_id (puede venir)
          it.sku ?? null,               // sku
          it.name ?? null,              // name
          it.qty,                       // qty
          it.line_total                 // amount
        );
      });

      if (values.length) {
        await client.query(
          `INSERT INTO app_sales_items
             (sale_id, line_pos, article_id, sku, name, qty, amount)
           VALUES ${values.join(',')}`,
          params
        );
      }

      // 2.b Mini-mapeo inmediato por nombre exacto (barato) dentro de estas ventas
      if (saleIds.length) {
        await client.query(
          `UPDATE app_sales_items si
             SET article_id = aa.id
           FROM app_sales s
           JOIN app_articles aa
             ON aa.business_id = s.business_id
          WHERE s.id = si.sale_id
            AND si.sale_id = ANY($1::int[])
            AND si.article_id IS NULL
            AND si.name IS NOT NULL
            AND lower(unaccent(si.name)) = lower(unaccent(aa.name))`,
          [saleIds]
        );
      }
    }

    // 3) Agregados diarios para días tocados
    let minDay = null, maxDay = null;
    if (touchedDays.length) {
      const days = touchedDays.sort();
      minDay = days[0];
      maxDay = days[days.length - 1];

      await client.query(
        `DELETE FROM sales_daily WHERE business_id = $1 AND day = ANY($2::date[]);`,
        [businessId, days]
      );
      await client.query(
        `DELETE FROM sales_daily_items WHERE business_id = $1 AND day = ANY($2::date[]);`,
        [businessId, days]
      );

      // Totales por día (tickets)
      await client.query(
        `INSERT INTO sales_daily (business_id, day, total, tx_count)
           SELECT s.business_id,
                  (s.occurred_at AT TIME ZONE 'UTC')::date AS day,
                  SUM(s.total) AS total,
                  COUNT(*)     AS tx_count
             FROM app_sales s
            WHERE s.business_id = $1
              AND (s.occurred_at AT TIME ZONE 'UTC')::date = ANY($2::date[])
         GROUP BY 1,2;`,
        [businessId, days]
      );

      // Ítems por artículo (excluye NULL y montos 0)
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
              AND si.article_id IS NOT NULL
              AND si.amount > 0
              AND (s.occurred_at AT TIME ZONE 'UTC')::date = ANY($2::date[])
         GROUP BY 1,2,3;`,
        [businessId, days]
      );
    }

    await client.query('COMMIT');
    return { upserted, updated, minDay, maxDay };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    if (!clientExtern) client.release();
  }
}

/**
 * Recalcula agregados diarios (sales_daily y sales_daily_items) para un rango [fromYmd..toYmd].
 * Útil para backfills o regeneraciones manuales.
 */
async function upsertDailyAggregates(businessId, fromYmd, toYmd) {
  await pool.query('BEGIN');
  try {
    await pool.query(
      `DELETE FROM sales_daily_items
        WHERE business_id = $1 AND day BETWEEN $2::date AND $3::date;
       DELETE FROM sales_daily
        WHERE business_id = $1 AND day BETWEEN $2::date AND $3::date;`,
      [businessId, fromYmd, toYmd]
    );

    // Totales por día
    await pool.query(
      `INSERT INTO sales_daily (business_id, day, total, tx_count)
         SELECT s.business_id,
                (s.occurred_at AT TIME ZONE 'UTC')::date AS day,
                SUM(s.total) AS total,
                COUNT(*)     AS tx_count
           FROM app_sales s
          WHERE s.business_id = $1
            AND (s.occurred_at AT TIME ZONE 'UTC')::date BETWEEN $2::date AND $3::date
       GROUP BY 1,2;`,
      [businessId, fromYmd, toYmd]
    );

    // Ítems por artículo (excluye NULL y montos 0)
    await pool.query(
      `INSERT INTO sales_daily_items (business_id, day, article_id, qty, amount)
         SELECT s.business_id,
                (s.occurred_at AT TIME ZONE 'UTC')::date AS day,
                si.article_id,
                SUM(si.qty)    AS qty,
                SUM(si.amount) AS amount
           FROM app_sales_items si
           JOIN app_sales s ON s.id = si.sale_id
          WHERE s.business_id = $1
            AND si.article_id IS NOT NULL
            AND si.amount > 0
            AND (s.occurred_at AT TIME ZONE 'UTC')::date BETWEEN $2::date AND $3::date
       GROUP BY 1,2,3;`,
      [businessId, fromYmd, toYmd]
    );

    await pool.query('COMMIT');
  } catch (e) {
    await pool.query('ROLLBACK');
    throw e;
  }
}

module.exports = {
  normalizeInvoices,
  upsertSalesBatch,
  upsertDailyAggregates,
};
