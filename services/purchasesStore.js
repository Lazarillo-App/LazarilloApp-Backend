// services/purchasesStore.js
'use strict';

const pool = require('../config/db');
const { propagarCostoInsumo } = require('./costoRecetaService');
const { getModoCosteo, calcularPreciosPorModo, aplicarPreciosCosteo } = require('./precioCosteoInsumos');

/* ─── helper: genera batch_id único ─── */
function generateBatchId() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const rand = Math.random().toString(16).slice(2, 6);
  return `${date}-${time}-${rand}`;
}

async function upsertPurchasesBatch(businessId, facturas, insumoMap, branchId = null) {
  const effectiveBatchId = generateBatchId();

  if (!facturas?.length) return { inserted: 0, updated: 0, items: 0, batch_id: effectiveBatchId };
  const client = await pool.connect();
  let inserted = 0, updated = 0, totalItems = 0;
  try {
    await client.query('BEGIN');
    const insumoIdsConCompra = new Set();
    for (const factura of facturas) {
      if (!factura) continue;
      const facturaKey = String(factura.numero ?? '').trim();
      if (!facturaKey) continue;
      const proveedorId = factura.proveedor ? Number(factura.proveedor) : null;
      const items = Array.isArray(factura.items) ? factura.items : [];

      let netoTotal = 0, ivaTotal = 0, impIntTotal = 0, percepTotal = 0;
      for (const it of items) {
        netoTotal   += Number(it.preciotot  ?? 0);
        ivaTotal    += Number(it.iva_total  ?? 0);
        impIntTotal += Number(it.imp_inttot ?? 0);
        // Percepciones (ej. IIBB) — solo las manda el pipeline nuevo de
        // MaxiRest (i25); el resto de los orígenes no tiene este campo y
        // queda en 0, sin cambiar nada de lo ya existente.
        percepTotal += Number(it.percep ?? 0);
      }
      const total = netoTotal + ivaTotal + impIntTotal + percepTotal;
      const fecha = items[0]?.fecha ?? null;

      const upsertRes = await client.query(
        `INSERT INTO purchases
           (business_id, factura_key, proveedor_id, fecha,
            neto_total, iva_total, imp_int_total, total,
            batch_id, branch_id,
            synced_at, updated_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),NOW())
            ON CONFLICT (business_id, factura_key, COALESCE(branch_id, -1)) DO UPDATE SET
            proveedor_id  = EXCLUDED.proveedor_id,
            fecha         = EXCLUDED.fecha,
            neto_total    = EXCLUDED.neto_total,
            iva_total     = EXCLUDED.iva_total,
            imp_int_total = EXCLUDED.imp_int_total,
            total         = EXCLUDED.total,
            synced_at     = NOW(),
            updated_at    = NOW()
            -- batch_id y branch_id NO se tocan → queda con el lote que lo subió primero
         RETURNING id, (xmax = 0) AS is_insert`,
        [businessId, facturaKey, proveedorId, fecha,
         netoTotal.toFixed(2), ivaTotal.toFixed(2),
         impIntTotal.toFixed(2), total.toFixed(2),
         effectiveBatchId, branchId ?? null]
      );

      const purchaseId = upsertRes.rows[0].id;
      const isInsert   = upsertRes.rows[0].is_insert;
      if (isInsert) inserted++; else updated++;

      await client.query('DELETE FROM purchase_items WHERE purchase_id = $1', [purchaseId]);

      for (const it of items) {
        const codigoMaxi = it.insumo != null ? Number(it.insumo) : null;
        const insumoId   = codigoMaxi != null ? (insumoMap.get(codigoMaxi) ?? null) : null;
        const itemFecha  = it.fecha ?? fecha;

        const cantidadTotal  = Number(it.cantidad ?? 0);
        const precioUnitario = Number(it.precio ?? 0);
        const factorNeto     = Number(it.neto ?? 0);

        await client.query(
          `INSERT INTO purchase_items
             (purchase_id, business_id, insumo_id, fecha,
              sucursal, cantidad, neto, precio, precio_total,
              iva_tasa, iva, iva_total_item,
              imp_int, imp_int_total, orden_compra, cpto_caja, referencia)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
          [purchaseId, businessId, insumoId,
           itemFecha, it.sucursal ?? 0,
           cantidadTotal, factorNeto, precioUnitario,
           it.preciotot ?? 0,
           it.iva_tasa ?? 0, it.iva ?? 0, it.iva_total ?? 0,
           it.imp_int ?? 0, it.imp_inttot ?? 0,
           it.orden_compra ?? 0, it.cptoCaja ?? 0, it.referencia ?? '']
        );
        totalItems++;

        if (insumoId && precioUnitario > 0 && itemFecha) {
          insumoIdsConCompra.add(insumoId);
        }
      }
    }

    // Qué precio le corresponde a precio_ref según el modo de costeo elegido
    // en Configuración > Insumos (última compra / promedio 30 días / precio
    // fijo del sistema) — antes esto siempre usaba "última compra" sin mirar
    // esa configuración.
    let preciosActualizados = 0;
    const modoCosteo = await getModoCosteo(businessId, client);
    const precios = await calcularPreciosPorModo(client, businessId, [...insumoIdsConCompra], modoCosteo);
    if (precios) {
      const idsActualizados = await aplicarPreciosCosteo(client, businessId, precios);
      preciosActualizados = idsActualizados.length;
      // El precio del insumo cambió: propagar en cascada a las recetas que lo usan
      // (y de ahí a elaborados que las usan a su vez). Sin esto, costo_total quedaba
      // congelado hasta que alguien reabría y volvía a guardar cada receta a mano.
      for (const insumoId of idsActualizados) {
        await propagarCostoInsumo(insumoId, businessId, client);
      }
    }

    await client.query('COMMIT');
    return { inserted, updated, items: totalItems, preciosActualizados, batch_id: effectiveBatchId };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function upsertSuppliers(businessId, proveedores) {
  if (!proveedores?.length) return 0;
  const client = await pool.connect();
  let count = 0;
  try {
    await client.query('BEGIN');
    for (const p of proveedores) {
      const id = Number(p.codigo);
      if (!Number.isFinite(id) || id <= 0) continue;
      await client.query(
        `INSERT INTO suppliers (id, business_id, nombre, razon_social, cuit, updated_at)
         VALUES ($1,$2,$3,$4,$5,NOW())
         ON CONFLICT (business_id, id) DO UPDATE SET
           nombre       = EXCLUDED.nombre,
           razon_social = EXCLUDED.razon_social,
           cuit         = EXCLUDED.cuit,
           updated_at   = NOW()`,
        [id, businessId, p.nombre ?? null, p.rs ?? null, p.cuit ?? null]
      );
      count++;
    }
    await client.query('COMMIT');
    return count;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { upsertPurchasesBatch, upsertSuppliers, generateBatchId };