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

/**
 * Agrupa las ventas crudas por día y por artículo.
 * Intenta adaptarse a varios formatos típicos de Maxi:
 *  - rawSales = [ { fecha / day / date, items: [ ... ] }, ... ]
 *  - o ya plano: [ { day, article_id, qty, amount }, ... ]
 */
function agruparPorDiaYArticulo(rawSales) {
  const byDay = new Map();

  for (const venta of rawSales || []) {
    // Normalizar día (YYYY-MM-DD)
    const day =
      (venta.day ||
       venta.fecha ||
       venta.date ||
       (venta.fechaHora && String(venta.fechaHora).slice(0, 10)) ||
       ''
      ).slice(0, 10);

    if (!day) continue;

    // Identificador de la transacción (para tx_count)
    const txId =
      venta.tx_id ||
      venta.id ||
      venta.numero ||
      venta.nro_comp ||
      venta.comprobante ||
      null;

    // Items: si viene un array de items/detalle, lo usamos; si no, tratamos la venta como si fuera un item plano
    const itemsArray =
      (Array.isArray(venta.items) && venta.items.length > 0)
        ? venta.items
        : (Array.isArray(venta.detalle) && venta.detalle.length > 0)
          ? venta.detalle
          : [venta];

    let info = byDay.get(day);
    if (!info) {
      info = {
        totalAmount: 0,
        txIds: new Set(),
        itemsMap: new Map(), // key = article_id
      };
      byDay.set(day, info);
    }

    if (txId) info.txIds.add(txId);

    for (const it of itemsArray) {
      const articleId = Number(
        it.article_id ??
        it.articulo_id ??
        it.item_id ??
        it.codigo ??
        it.cod_articulo
      );

      if (!Number.isFinite(articleId) || articleId <= 0) continue;

      const qty = Number(
        it.qty ??
        it.cantidad ??
        it.quantity ??
        it.cant
      ) || 0;

      const amount = Number(
        it.amount ??
        it.importe ??
        it.total ??
        it.totalLinea ??
        it.total_linea
      ) || 0;

      info.totalAmount += amount;

      const prev =
        info.itemsMap.get(articleId) ||
        { article_id: articleId, qty: 0, amount: 0 };

      prev.qty += qty;
      prev.amount += amount;

      info.itemsMap.set(articleId, prev);
    }
  }

  // Convertimos el Map a objeto simple para usar después
  const out = {};
  for (const [day, info] of byDay.entries()) {
    out[day] = {
      totalAmount: info.totalAmount,
      txCount: info.txIds.size,
      itemsAgg: Array.from(info.itemsMap.values()),
    };
  }
  return out;
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
 * Inserta/actualiza ventas e ítems en app_sales / app_sales_items
 * y recalcula agregados diarios (sales_daily + sales_daily_items)
 * SOLO para los días tocados.
 *
 * Devuelve { upserted, updated, minDay, maxDay }
 *
 * Nota: soporta client opcional (para usar dentro de una transacción externa).
 */
async function upsertSalesBatch(businessId, rawSales, clientOpt) {
  if (!Array.isArray(rawSales) || rawSales.length === 0) {
    return { upserted: 0, updated: 0, minDay: null, maxDay: null };
  }

  // 1) Normalizar las facturas crudas (fullinvoicebydate / invoicebydate)
  const { sales, items, touchedDays } = normalizeInvoices(businessId, rawSales);

  if (sales.length === 0) {
    return { upserted: 0, updated: 0, minDay: null, maxDay: null };
  }

  // 2) Rango de días tocados (YYYY-MM-DD)
  const days = touchedDays.slice().sort();
  const minDay = days[0];
  const maxDay = days[days.length - 1];

  const client = clientOpt || await pool.connect();
  const ownClient = !clientOpt;

  let upserted = 0;
  let updated  = 0;

  try {
    if (ownClient) {
      await client.query('BEGIN');
    }

    /* ───────── 2A) UPSERT en app_sales ───────── */
    const saleIdByIdx = new Array(sales.length);

    for (let i = 0; i < sales.length; i += 1) {
      const s = sales[i];

      // external_id + business_id definen la “venta” única
      const r = await client.query(
        `
        INSERT INTO app_sales (business_id, external_id, occurred_at, total)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (business_id, external_id)
        DO UPDATE SET
          occurred_at = EXCLUDED.occurred_at,
          total       = EXCLUDED.total
        RETURNING id, (xmax = 0) AS inserted;
        `,
        [s.business_id, s.external_id, s.occurred_at, s.total]
      );

      const row = r.rows[0];
      saleIdByIdx[i] = row.id;

      if (row.inserted) upserted += 1;
      else             updated  += 1;
    }

    /* ───────── 2B) Reemplazar ÍTEMS de esas ventas ───────── */
    const saleIdsUnique = [...new Set(saleIdByIdx)].filter(Boolean);

    if (saleIdsUnique.length > 0) {
      await client.query(
        `
        DELETE FROM app_sales_items
        WHERE sale_id = ANY($1::int[])
          AND business_id = $2
        `,
        [saleIdsUnique, businessId]
      );
    }

    if (items.length > 0) {
      const values = [];
      const params = [];
      let idx = 1;

      for (const it of items) {
        const saleId = saleIdByIdx[it.sale_idx];
        if (!saleId) continue;

        values.push(
          `($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`
        );

        params.push(
          saleId,                 // sale_id
          businessId,             // business_id
          it.article_id ?? null,  // article_id (null si no hay cod_art)
          it.sku || null,         // sku
          it.name || null,        // name (titulo observado)
          toNum(it.qty),          // qty
          toNum(it.line_total),   // amount
          toNum(it.line_total)    // total (duplicamos por compat)
        );
      }

      if (values.length > 0) {
        await client.query(
          `
          INSERT INTO app_sales_items
            (sale_id, business_id, article_id, sku, name, qty, amount, total)
          VALUES
            ${values.join(', ')}
          `,
          params
        );
      }
    }

    /* ───────── 2C) Reconciliar mappings artículo (nombre ↔ maxi_article_map) ───────── */
    await reconcileSalesMappings(client, businessId, {
      fromYmd: minDay,
      toYmd:   maxDay,
    });

    /* ───────── 2D) Recalcular agregados diarios ───────── */
    await upsertDailyAggregates(businessId, minDay, maxDay, client);

    if (ownClient) {
      await client.query('COMMIT');
    }

    return { upserted, updated, minDay, maxDay };
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
