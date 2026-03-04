// services/purchasesStore.js
'use strict';

const pool = require('../config/db');

async function upsertPurchasesBatch(businessId, facturas, insumoMap) {
  if (!facturas?.length) return { inserted: 0, updated: 0, items: 0 };
  const client = await pool.connect();
  let inserted = 0, updated = 0, totalItems = 0;
  try {
    await client.query('BEGIN');
    for (const factura of facturas) {
      if (!factura) continue; // MaxiRest puede mandar nulls en el array
      const facturaKey = String(factura.numero ?? '').trim();
      if (!facturaKey) continue;
      const proveedorId = factura.proveedor ? Number(factura.proveedor) : null;
      const items = Array.isArray(factura.items) ? factura.items : [];

      // Totales desde items (neto unitario*cantidad = preciotot)
      let netoTotal = 0, ivaTotal = 0, impIntTotal = 0;
      for (const it of items) {
        netoTotal   += Number(it.preciotot  ?? 0);
        ivaTotal    += Number(it.iva_total  ?? 0);
        impIntTotal += Number(it.imp_inttot ?? 0);
      }
      const total = netoTotal + ivaTotal + impIntTotal;
      const fecha = items[0]?.fecha ?? null;

      const upsertRes = await client.query(
        `INSERT INTO purchases
           (business_id, factura_key, proveedor_id, fecha,
            neto_total, iva_total, imp_int_total, total,
            synced_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW())
         ON CONFLICT (business_id, factura_key) DO UPDATE SET
           proveedor_id  = EXCLUDED.proveedor_id,
           fecha         = EXCLUDED.fecha,
           neto_total    = EXCLUDED.neto_total,
           iva_total     = EXCLUDED.iva_total,
           imp_int_total = EXCLUDED.imp_int_total,
           total         = EXCLUDED.total,
           synced_at     = NOW(),
           updated_at    = NOW()
         RETURNING id, (xmax = 0) AS is_insert`,
        [businessId, facturaKey, proveedorId, fecha,
         netoTotal.toFixed(2), ivaTotal.toFixed(2),
         impIntTotal.toFixed(2), total.toFixed(2)]
      );

      const purchaseId = upsertRes.rows[0].id;
      const isInsert   = upsertRes.rows[0].is_insert;
      if (isInsert) inserted++; else updated++;

      // Eliminar items anteriores antes de reinsertar
      await client.query('DELETE FROM purchase_items WHERE purchase_id = $1', [purchaseId]);

      for (const it of items) {
        const codigoMaxi = it.insumo != null ? Number(it.insumo) : null;
        const insumoId   = codigoMaxi != null ? (insumoMap.get(codigoMaxi) ?? null) : null;
        await client.query(
          `INSERT INTO purchase_items
             (purchase_id, business_id, insumo_id, fecha,
              sucursal, cantidad, neto, precio, precio_total,
              iva_tasa, iva, iva_total_item,
              imp_int, imp_int_total, orden_compra, cpto_caja, referencia)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
          [purchaseId, businessId, insumoId,
           it.fecha ?? fecha,
           it.sucursal ?? 0, it.cantidad ?? 0, it.neto ?? 0,
           it.precio ?? 0, it.preciotot ?? 0,
           it.iva_tasa ?? 0, it.iva ?? 0, it.iva_total ?? 0,
           it.imp_int ?? 0, it.imp_inttot ?? 0,
           it.orden_compra ?? 0, it.cptoCaja ?? 0, it.referencia ?? '']
        );
        totalItems++;
      }
    }
    await client.query('COMMIT');
    return { inserted, updated, items: totalItems };
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
         ON CONFLICT (id) DO UPDATE SET
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

module.exports = { upsertPurchasesBatch, upsertSuppliers };