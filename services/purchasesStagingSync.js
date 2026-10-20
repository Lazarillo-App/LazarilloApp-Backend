// services/purchasesStagingSync.js
//
// Paso de normalización de la Fase 1 de ingesta automática de MaxiRest
// (ver plan). Lee las líneas crudas que el agente Python del colega fue
// dejando en `maxi_purchases_staging` (traducidas 1:1 desde `mxitc`, la
// tabla de línea de comprobante de compra en el espejo MySQL de MaxiRest),
// las agrupa en la forma `{ numero, proveedor, items: [...] }` que YA
// espera `purchasesStore.upsertPurchasesBatch`, y le delega todo el resto
// (upsert de purchases/purchase_items + la cascada de costeo con reglas de
// bonificación) sin tocar esa función.
//
// Deliberadamente NO reimplementa nada de esa lógica acá.
'use strict';

const pool = require('../config/db');
const { buildInsumoMap } = require('../controllers/purchasesController');
const { upsertPurchasesBatch } = require('./purchasesStore');

// Agrupa filas de staging en facturas, con la forma exacta que espera
// upsertPurchasesBatch. Clave de agrupación = comprobante real en MaxiRest:
// proveedor + tipo de comprobante + número (numero2 de mxitc no se usa,
// resultó ser la fecha re-codificada, no parte del número real).
function agruparEnFacturas(filas) {
  const porFactura = new Map();
  for (const f of filas) {
    const key = `${f.cod_pro}__${f.cod_cpb}__${f.numero1}__${f.cod_suc}`;
    if (!porFactura.has(key)) {
      porFactura.set(key, {
        numero: `${String(f.cod_cpb ?? '').trim()}-${f.numero1}`,
        proveedor: f.cod_pro,
        items: [],
      });
    }
    porFactura.get(key).items.push({
      insumo: f.cod_ins,
      fecha: f.fecha,
      cantidad: f.cantidad,
      precio: f.precio,
      neto: f.neto,
      preciotot: f.preciotot,
      iva_tasa: f.tasa,
      iva: f.iva,
      iva_total: f.ivatot,
      imp_int: f.imp_int,
      imp_inttot: f.imp_inttot,
      orden_compra: f.orden,
      cptoCaja: f.cod_cga,
      referencia: f.referencia,
      sucursal: f.cod_suc,
    });
  }
  return [...porFactura.values()];
}

// Procesa el staging pendiente de UN negocio. branchId siempre null por
// ahora (Fase 0 todavía no confirmó que cod_suc varíe de verdad para el
// negocio piloto; si varía, se revisita este mapeo antes de activarlo).
async function syncPurchasesFromStaging(businessId, { dryRun = false } = {}) {
  const { rows: filas } = await pool.query(
    `SELECT * FROM maxi_purchases_staging WHERE business_id = $1 AND procesado = FALSE`,
    [businessId]
  );
  if (!filas.length) {
    return { facturas: 0, items: 0, sinInsumo: 0, dryRun, resultado: null };
  }

  const facturas = agruparEnFacturas(filas);
  const insumoMap = await buildInsumoMap(businessId);

  let sinInsumo = 0;
  for (const f of facturas) {
    for (const it of f.items) {
      if (it.insumo == null || !insumoMap.has(Number(it.insumo))) sinInsumo++;
    }
  }

  if (dryRun) {
    return { facturas: facturas.length, items: filas.length, sinInsumo, dryRun, resultado: null };
  }

  const resultado = await upsertPurchasesBatch(businessId, facturas, insumoMap, null);

  const ids = filas.map((f) => f.id);
  await pool.query(
    `UPDATE maxi_purchases_staging SET procesado = TRUE, processed_at = NOW() WHERE id = ANY($1::bigint[])`,
    [ids]
  );

  return { facturas: facturas.length, items: filas.length, sinInsumo, dryRun, resultado };
}

module.exports = { syncPurchasesFromStaging, agruparEnFacturas };
