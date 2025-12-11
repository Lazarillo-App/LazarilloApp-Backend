// services/salesStore.js
const pool = require('../config/db');

/* ───────── helpers num/date ───────── */

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

const toNum = (v) => {
  if (v == null || v === '') return 0;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
};

function normalizeCode(raw) {
  if (raw == null) return null;
  return String(raw).trim();
}

function extractCode(it) {
  const raw =
    it.cod_art ??
    it.cod_articulo ??
    it.codigo ??
    it.codigo_articulo ??
    it.code ??
    it.article_id ??
    it.articulo_id ??
    it.item_id ??
    null;

  if (raw == null || raw === '') {
    return { externalCode: null, articleId: null };
  }

  const externalCode = String(raw).trim();
  const num = Number(externalCode);
  const articleId = Number.isFinite(num) && num > 0 ? num : null;

  return { externalCode, articleId };
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
// services/salesStore.js

function normalizeInvoices(businessId, rawDocs) {
  console.log('🔍 normalizeInvoices iniciando - versión CON deduplicación');
  const sales = [];
  const items = [];
  const touchedDays = new Set();
  const seenIds = new Set();

  const pushSale = (external_id, occurred_at, total) => {
    const s = { business_id: businessId, external_id, occurred_at, total: toNum(total) };
    sales.push(s);
    touchedDays.add(s.occurred_at.toISOString().slice(0, 10));
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
      amount: toNum(data.line_total),
      total: toNum(data.line_total),
    });
  };

  (rawDocs || []).forEach((doc) => {
    // ───────── invoicebydate (órdenes) ─────────
    // ───────── invoicebydate (órdenes) ─────────
    const ord = doc?.order;
    if (ord?.orderData) {
      const od = ord.orderData;
      const oid = od.orderId ? String(od.orderId).trim() : null;
      console.log('🔍 Procesando venta:', oid, '| Ya vista?', seenIds.has(oid));
      const occurred = parseYMDorDMYtoUTC(od.orderDate || od.date);

      if (!occurred) return;

      // 🆕 DEDUPLICACIÓN
      if (oid && seenIds.has(oid)) {
        console.log(`⚠️ DUPLICADO DETECTADO: ${oid} - IGNORANDO`);
        return;
      }
      if (oid) seenIds.add(oid);

      // 🎯 NUEVO: Procesar AMBOS tipos de items
      const allItems = [];

      // 1️⃣ Procesar orderItems (tienen quantity explícita)
      const orderItems = Array.isArray(ord.orderItems) ? ord.orderItems : [];
      for (const wrap of orderItems) {
        const oi = wrap?.orderItem || wrap || {};

        allItems.push({
          title: oi.title || oi.nombre_art || 'Item',
          qty: toNum(oi.quantity || 1), // ← quantity puede faltar, default 1
          totalPrice: toNum(oi.totalPrice),
          productPrice: toNum(oi.productPrice),
          type: 'order',
        });
      }

      // 2️⃣ Procesar menuItems (SIEMPRE cantidad 1)
      const menuItems = Array.isArray(ord.menuItems) ? ord.menuItems : [];
      for (const wrap of menuItems) {
        const mi = wrap?.menuItem || wrap || {};

        // ✅ Solo agregar si NO está ya en orderItems (evitar duplicados por título)
        const exists = allItems.some(
          x => x.title && mi.title &&
            x.title.toLowerCase().trim() === mi.title.toLowerCase().trim()
        );

        if (!exists) {
          allItems.push({
            title: mi.title || 'Menu Item',
            qty: 1, // ← menuItems SIEMPRE son 1
            totalPrice: toNum(mi.productPrice), // menuItems usan productPrice como total
            productPrice: toNum(mi.productPrice),
            type: 'menu',
          });
        }
      }

      // 🎯 Calcular total desde TODOS los items procesados
      const total = allItems.reduce((sum, it) => sum + it.totalPrice, 0);

      console.log('🧮 ANÁLISIS DE ITEMS:');
      console.log(`   orderItems: ${orderItems.length}`);
      console.log(`   menuItems: ${menuItems.length}`);
      console.log(`   Items procesados (sin duplicados): ${allItems.length}`);
      console.log(`   Total calculado: ${total}`);
      console.log('');

      const sale_idx = sales.length;
      pushSale(oid, occurred, total);

      // 🎯 Insertar TODOS los items (order + menu)
      allItems.forEach((it, i) => {
        const qty = it.qty;
        const totalPrice = it.totalPrice;
        const unit_price = (qty > 0 && totalPrice > 0)
          ? (totalPrice / qty)
          : it.productPrice;

        console.log(`📦 Item ${i + 1} (${it.type}):`, {
          title: it.title,
          qty,
          totalPrice,
          unit_price,
        });

        pushItem(sale_idx, i + 1, {
          sku: null,
          article_name: it.title,
          qty,
          unit_price,
          line_total: totalPrice,
        });
      });

      return;
    }

    // ───────── fullinvoicebydate (facturas) ─────────
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

        const { externalCode } = extractCode(it);

        pushItem(sale_idx, i + 1, {
          sku: externalCode,
          article_name: nombre,
          qty: cantidad,
          unit_price: precio,
          line_total: lineTotal,
        });
      });
      return;
    }
  });

  return { sales, items, touchedDays: Array.from(touchedDays) };
}

/**
 * Inserta/actualiza ventas e ítems en app_sales / app_sales_items
 * y recalcula agregados diarios (sales_daily + sales_daily_items)
 * SOLO para los días tocados.
 *
 * Devuelve { upserted, updated, minDay, maxDay }
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
  let updated = 0;

  try {
    if (ownClient) {
      await client.query('BEGIN');
    }

    /* ───────── 2A) UPSERT en app_sales ───────── */
    const saleIdByIdx = new Array(sales.length);

    for (let i = 0; i < sales.length; i += 1) {
      const s = sales[i];

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
      else updated += 1;
    }

    /* ───────── 2B) Limpiar ítems anteriores de esas ventas ───────── */
    const saleIdsUnique = [...new Set(saleIdByIdx)].filter(Boolean);

    if (saleIdsUnique.length > 0) {
      await client.query(
        `
        DELETE FROM app_sales_items
        WHERE sale_id = ANY($1::int[])
        `,
        [saleIdsUnique]
      );
    }

    /* ───────── 2C) Insertar ítems normalizados ───────── */
    if (items.length > 0) {
      const values = [];
      const params = [];
      let idx = 1;

      for (const it of items) {
        const saleId = saleIdByIdx[it.sale_idx];
        if (!saleId) continue;

        const linePos = Number.isFinite(it.line_pos) ? it.line_pos : 1;

        // 🎯 AGREGAMOS unit_price al INSERT
        values.push(
          `($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`
        );

        params.push(
          saleId,                   // sale_id
          linePos,                  // line_pos
          it.article_id ?? null,    // article_id
          it.sku || null,           // sku
          it.name || null,          // name
          toNum(it.qty),            // qty
          toNum(it.unit_price),     // unit_price  👈 AGREGADO
          toNum(it.amount),         // amount
          toNum(it.total)           // total
        );
      }

      if (values.length > 0) {
        await client.query(
          `
      INSERT INTO app_sales_items
        (sale_id, line_pos, article_id, sku, name, qty, unit_price, amount, total)
      VALUES
        ${values.join(', ')}
      `,
          params
        );
      }
    }

    /* ───────── 2D) Reconciliar mappings de artículos ───────── */
    await reconcileSalesMappings(client, businessId, {
      fromYmd: minDay,
      toYmd: maxDay,
    });

    /* ───────── 2E) Recalcular agregados diarios ───────── */
    await upsertDailyAggregates(businessId, minDay, maxDay, client);

    if (ownClient) {
      await client.query('COMMIT');
    }

    return { upserted, updated, minDay, maxDay };
  } catch (e) {
    if (ownClient) {
      try { await client.query('ROLLBACK'); } catch { }
    }
    throw e;
  } finally {
    if (ownClient) {
      client.release();
    }
  }
}

/**
 * Recalcula agregados entre dos fechas (incl.).
 * Usa app_sales y app_sales_items como fuente única de verdad.
 */
async function upsertDailyAggregates(businessId, fromYmd, toYmd, clientOpt) {
  const client = clientOpt || await pool.connect();
  const ownClient = !clientOpt;

  try {
    if (ownClient) {
      await client.query('BEGIN');
    }

    const params = [businessId, fromYmd, toYmd];

    /* 1) sales_daily: totales por día (derivados de los ítems) */
    const sqlDaily = `
      INSERT INTO sales_daily (business_id, day, total, tx_count)
      SELECT
        s.business_id,
        (s.occurred_at AT TIME ZONE 'UTC')::date AS day,
        -- 💰 Total = suma de los importes de los ítems
        SUM(
          CASE
            WHEN si.amount IS NOT NULL AND si.amount <> 0
              THEN si.amount
            WHEN si.total IS NOT NULL
              THEN si.total
            ELSE 0
          END
        ) AS total,
        -- 🎟️ Cantidad de tickets distintos
        COUNT(DISTINCT s.id) AS tx_count
      FROM app_sales_items si
      JOIN app_sales s
        ON s.id = si.sale_id
      WHERE s.business_id = $1
        AND (s.occurred_at AT TIME ZONE 'UTC')::date BETWEEN $2 AND $3
      GROUP BY
        s.business_id,
        (s.occurred_at AT TIME ZONE 'UTC')::date
      ON CONFLICT (business_id, day)
      DO UPDATE SET
        total    = EXCLUDED.total,
        tx_count = EXCLUDED.tx_count
    `;
    await client.query(sqlDaily, params);

    /* 2) sales_daily_items: totales por día + artículo
       👇 Ojo: NULL → 0 para mantener NOT NULL en article_id
    */
    const sqlItems = `
      INSERT INTO sales_daily_items (business_id, day, article_id, qty, amount)
      SELECT
        s.business_id,
        (s.occurred_at AT TIME ZONE 'UTC')::date AS day,
        COALESCE(si.article_id, 0) AS article_id,
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
        AND (s.occurred_at AT TIME ZONE 'UTC')::date BETWEEN $2 AND $3
      GROUP BY
        s.business_id,
        (s.occurred_at AT TIME ZONE 'UTC')::date,
        COALESCE(si.article_id, 0)
      ON CONFLICT (business_id, day, article_id)
      DO UPDATE SET
        qty    = EXCLUDED.qty,
        amount = EXCLUDED.amount
    `;
    await client.query(sqlItems, params);

    /* 3) maxi_sales_daily: espejo 1:1 de sales_daily_items
         👉 SIN filtrar article_id: copiamos también el 0
    */
    const sqlMaxiDaily = `
  INSERT INTO maxi_sales_daily (business_id, articulo_id, day, qty, amount)
  SELECT
    business_id,
    article_id AS articulo_id,
    day,
    qty,
    amount
  FROM sales_daily_items
  WHERE business_id = $1
    AND day BETWEEN $2 AND $3
  ON CONFLICT (business_id, articulo_id, day)
  DO UPDATE SET
    qty        = EXCLUDED.qty,
    amount     = EXCLUDED.amount,
    updated_at = now()
`;
    await client.query(sqlMaxiDaily, params);

    if (ownClient) {
      await client.query('COMMIT');
    }
  } catch (e) {
    if (ownClient) {
      try { await client.query('ROLLBACK'); } catch { }
    }
    throw e;
  } finally {
    if (ownClient) {
      client.release();
    }
  }
};

async function reconcileSalesMappings(client, businessId, { fromYmd, toYmd }) {
  if (!fromYmd || !toYmd) return;

  // 1) Match por código externo (preciso) usando maxi_article_map
  await client.query(
    `
    UPDATE app_sales_items si
       SET article_id = COALESCE(m.article_id, m.articulo_id)
      FROM app_sales s
      JOIN maxi_article_map m
        ON m.business_id = s.business_id
     WHERE s.id = si.sale_id
       AND s.business_id = $1
       AND (si.article_id IS NULL OR si.article_id = 0)
       AND si.sku IS NOT NULL
       AND (
         trim(si.sku) = trim(m.external_code)
         OR (
           si.sku ~ '^[0-9]+$'
           AND m.external_code ~ '^[0-9]+$'
           AND si.sku::bigint = m.external_code::bigint
         )
       )
       AND (s.occurred_at AT TIME ZONE 'UTC')::date
           BETWEEN $2::date AND $3::date
    `,
    [businessId, fromYmd, toYmd]
  );

  // 2) Match por nombre normalizado (fallback) usando maxi_article_map.title
  await client.query(
    `
    UPDATE app_sales_items si
       SET article_id = COALESCE(m.article_id, m.articulo_id)
      FROM app_sales s
      JOIN maxi_article_map m
        ON m.business_id = s.business_id
     WHERE s.id = si.sale_id
       AND s.business_id = $1
       AND (si.article_id IS NULL OR si.article_id = 0)
       AND si.name IS NOT NULL
       AND m.title IS NOT NULL
       AND lower(unaccent(si.name)) = lower(unaccent(m.title))
       AND (s.occurred_at AT TIME ZONE 'UTC')::date
           BETWEEN $2::date AND $3::date
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
