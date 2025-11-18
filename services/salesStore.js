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
  // fallback robusto (solo parte de fecha en UTC)
  const d = new Date(dateStr);
  return Number.isFinite(+d)
    ? new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
    : null;
}

/*
  Normaliza ambos formatos:
  - fullinvoicebydate: { numero, total, cabecera{ fecha }, items[] { cod_art, nombre_art, cantidad, precio, total } }
  - invoicebydate:     { order{ orderData{ orderId, orderDate, totalSales }, orderItems:[{ orderItem{ cod_art, title, quantity, productPrice, totalPrice } }] } }
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
    // data: { article_id?, sku?, article_name, qty, unit_price, line_total }
    items.push({
      business_id: businessId,
      sale_idx,
      line_pos,
      article_id: data.article_id ?? null,
      sku: data.sku ?? null,
      name: data.article_name || null, // guardamos el nombre observado
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
      if (!occurred) return;

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
      if (!occurred) return;

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

    // otros objetos: ignorar
  });

  return { sales, items, touchedDays: Array.from(touchedDays) };
}

/**
 * Inserta/actualiza ventas e ítems y recalcula agregados diarios SOLO para los días tocados.
 * Devuelve { upserted, updated, minDay, maxDay }
 */
async function upsertSalesBatch(businessId, rawSales) {
  // rawSales = lista de facturas ya normalizadas con items adentro
  // agrupás por día y por artículo
  const byDay = agruparPorDiaYArticulo(rawSales);

  let minDay = null;
  let maxDay = null;
  let upserted = 0;
  let updated  = 0;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const [day, info] of Object.entries(byDay)) {
      const { totalAmount, txCount, itemsAgg } = info;

      // A) upsert en sales_daily
      const { rowCount } = await client.query(
        `
        INSERT INTO sales_daily (business_id, day, total_amount, tx_count)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (business_id, day)
        DO UPDATE SET
          total_amount = EXCLUDED.total_amount,
          tx_count     = EXCLUDED.tx_count
        `,
        [businessId, day, totalAmount, txCount]
      );

      if (rowCount === 1) {
        // No podemos saber fácil si fue insert u update
        // pero si querés llevar la cuenta:
        // podés hacer un SELECT previo o usar RETURNING con xmax = 0 como truco,
        // por ahora dejamos upserted/updated aproximados.
        upserted += 1;
      } else {
        updated += 1;
      }

      // B) limpiás detalle viejo del día
      await client.query(
        `DELETE FROM sales_daily_items
         WHERE business_id = $1 AND day = $2`,
        [businessId, day]
      );

      // C) insertás items agregados del día
      if (itemsAgg.length > 0) {
        const values = [];
        const params = [];
        let idx = 1;

        for (const it of itemsAgg) {
          values.push(
            `($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`
          );
          params.push(
            businessId,
            day,
            it.article_id,
            it.qty,
            it.amount
          );
        }

        await client.query(
          `
          INSERT INTO sales_daily_items (business_id, day, article_id, qty, amount)
          VALUES ${values.join(',')}
          `,
          params
        );
      }

      // actualizar min/max day
      if (!minDay || day < minDay) minDay = day;
      if (!maxDay || day > maxDay) maxDay = day;
    }

    await client.query('COMMIT');

    return { upserted, updated, minDay, maxDay };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Recalcula agregados entre dos fechas (incl.). Usa qty real.
 */
async function upsertDailyAggregates(businessId, fromYmd, toYmd, clientOpt) {
  const client = clientOpt || await pool.connect();
  const ownClient = !clientOpt;

  try {
    if (ownClient) {
      await client.query('BEGIN');
    }

    const params = [businessId, fromYmd, toYmd];

    /* 1) sales_daily: totales por día */
    const sqlDaily = `
      INSERT INTO sales_daily (business_id, day, total, tx_count)
      SELECT
        s.business_id,
        (s.occurred_at AT TIME ZONE 'UTC')::date AS day,
        SUM(s.total) AS total,
        COUNT(*)    AS tx_count
      FROM app_sales s
      WHERE s.business_id = $1
        AND (s.occurred_at AT TIME ZONE 'UTC')::date BETWEEN $2 AND $3
      GROUP BY s.business_id, (s.occurred_at AT TIME ZONE 'UTC')::date
      ON CONFLICT (business_id, day)
      DO UPDATE SET
        total    = EXCLUDED.total,
        tx_count = EXCLUDED.tx_count
    `;
    await client.query(sqlDaily, params);

    /* 2) sales_daily_items: totales por día + artículo */
    const sqlItems = `
      INSERT INTO sales_daily_items (business_id, day, article_id, qty, amount)
      SELECT
        s.business_id,
        (s.occurred_at AT TIME ZONE 'UTC')::date AS day,
        si.article_id,
        -- Cantidad: priorizamos si.qty, si no quantity
        SUM(
          CASE
            WHEN si.qty IS NOT NULL AND si.qty <> 0
              THEN si.qty
            WHEN si.quantity IS NOT NULL
              THEN si.quantity
            ELSE 0
          END
        ) AS qty,
        -- Importe: priorizamos si.amount, si no total
        SUM(
          CASE
            WHEN si.amount IS NOT NULL AND si.amount <> 0
              THEN si.amount
            WHEN si.total IS NOT NULL
              THEN si.total
            ELSE 0
          END
        ) AS amount
      FROM app_sales_items si
      JOIN app_sales s
        ON s.id = si.sale_id
      WHERE s.business_id = $1
        AND si.article_id IS NOT NULL
        AND (s.occurred_at AT TIME ZONE 'UTC')::date BETWEEN $2 AND $3
      GROUP BY
        s.business_id,
        (s.occurred_at AT TIME ZONE 'UTC')::date,
        si.article_id
      ON CONFLICT (business_id, day, article_id)
      DO UPDATE SET
        qty    = EXCLUDED.qty,
        amount = EXCLUDED.amount
    `;
    await client.query(sqlItems, params);

    if (ownClient) {
      await client.query('COMMIT');
    }
  } catch (e) {
    if (ownClient) {
      try { await client.query('ROLLBACK'); } catch {}
    }
    throw e;
  } finally {
    if (ownClient) {
      client.release();
    }
  }
}

async function reconcileSalesMappings(client, businessId, { fromYmd, toYmd }) {
  if (!fromYmd || !toYmd) return;

  // 1) Match por código externo (preciso)
  await client.query(
    `
    UPDATE app_sales_items si
       SET article_id = m.article_id
      FROM app_sales s
      JOIN maxi_article_map m
        ON m.business_id = s.business_id
       AND m.external_code IS NOT NULL
     WHERE s.id = si.sale_id
       AND s.business_id = $1
       AND si.article_id IS NULL
       AND si.sku IS NOT NULL
       AND si.sku = m.external_code
       AND (s.occurred_at AT TIME ZONE 'UTC')::date BETWEEN $2::date AND $3::date
    `,
    [businessId, fromYmd, toYmd]
  );

  // 2) Match por nombre normalizado (fallback)
  await client.query(
    `
    UPDATE app_sales_items si
       SET article_id = m.article_id
      FROM app_sales s
      JOIN maxi_article_map m
        ON m.business_id = s.business_id
     WHERE s.id = si.sale_id
       AND s.business_id = $1
       AND si.article_id IS NULL
       AND si.name IS NOT NULL
       AND lower(unaccent(si.name)) = lower(unaccent(m.title))
       AND (s.occurred_at AT TIME ZONE 'UTC')::date BETWEEN $2::date AND $3::date
    `,
    [businessId, fromYmd, toYmd]
  );
}

module.exports = {
  normalizeInvoices,
  upsertSalesBatch,
  upsertDailyAggregates,
  reconcileSalesMappings,
};
