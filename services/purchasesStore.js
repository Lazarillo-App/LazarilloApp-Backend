// services/purchasesStore.js
'use strict';

const pool = require('../config/db');
const { propagarCostoInsumo } = require('./costoRecetaService');
const { getModoCosteo, getConImpuestos, calcularPreciosPorModo, aplicarPreciosCosteo, RATIO_PRECIO_SOSPECHOSO } = require('./precioCosteoInsumos');

// Un código de MaxiRest puede coincidir por pura casualidad numérica con el
// codigo_maxi de un insumo real (confirmado con decenas de casos: gastos
// administrativos — luz, impuestos, seguros, contador, comisiones de
// delivery — matcheando insumos como Barril Golden, Agua Sin Gas, Medallón
// Carne, con precios hasta 4000 veces el real). El tipo de comprobante y el
// rubro de origen (cod_cga) NO alcanzan como filtro: hay demasiadas
// variantes y crecen con cada negocio nuevo. En cambio, el precio real
// pagado por un insumo cambia poco de una compra a otra (como mucho unas
// pocas veces por inflación) — un salto de RATIO_PRECIO_SOSPECHOSO veces o
// más contra la mediana de lo ya comprado es, en la práctica, siempre un
// code mismatch, nunca una suba de precio real. Protege cualquier vía de
// ingreso de compras (no solo MaxiRest), ya que vive en el punto compartido
// donde se resuelve insumo_id. Mismo umbral que usa calcularPreciosPorModo
// para el filtro de "última compra razonable" (precioCosteoInsumos.js).

// Mediana de precio unitario ya pagado por cada insumo (sobre lo ya
// cargado en purchase_items) — la vara contra la que se mide cada línea
// NUEVA, de a una, para no rechazar un insumo entero por culpa de una sola
// línea sucia mezclada con compras reales en el mismo lote.
async function obtenerMedianasPrevias(client, businessId, insumoIds) {
  if (!insumoIds.length) return new Map();
  const { rows } = await client.query(
    `SELECT insumo_id, percentile_cont(0.5) WITHIN GROUP (ORDER BY precio) AS mediana
       FROM purchase_items
      WHERE business_id = $1 AND insumo_id = ANY($2::int[]) AND precio > 0
      GROUP BY insumo_id`,
    [businessId, insumoIds]
  );
  return new Map(rows.map((r) => [Number(r.insumo_id), Number(r.mediana)]));
}

/* ─── helper: genera batch_id único ─── */
function generateBatchId() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const rand = Math.random().toString(16).slice(2, 6);
  return `${date}-${time}-${rand}`;
}

// Clave de una factura cargada en el Panel: "A-2-69930~<proveedor>", y "~<fecha>" en tickets, cuyo
// número se repite. purchases es único por negocio + clave, sin proveedor: con la clave pelada, la
// factura de otro proveedor con el mismo número pisaría a esta. Las lecturas muestran hasta el "~".
function facturaKeyPanel({ letra, prefijo, numero, codigo, fecha }) {
  const tipo = String(letra).toUpperCase().replace(/^NC[ABC]?$/, 'NC');
  const base = `${tipo}-${Number(prefijo)}-${Number(numero)}~${codigo}`;
  return tipo === 'Z' ? `${base}~${String(fecha).slice(0, 10)}` : base;
}

// Recalcula precio_ref según el modo de costeo y propaga a las recetas. Las compras se leen de
// businessId; los insumos pueden vivir en otro negocio (insumosBizId, el principal de la org).
async function actualizarPreciosDeInsumos(client, { businessId, insumosBizId = businessId, insumoIds }) {
  const modoCosteo = await getModoCosteo(insumosBizId, client);
  const conImpuestos = await getConImpuestos(insumosBizId, client);
  const precios = await calcularPreciosPorModo(client, businessId, insumoIds, modoCosteo, { conImpuestos });
  if (!precios) return 0;
  const idsActualizados = await aplicarPreciosCosteo(client, insumosBizId, precios);
  // El precio del insumo cambió: propagar en cascada a las recetas que lo usan
  // (y de ahí a elaborados que las usan a su vez). Sin esto, costo_total quedaba
  // congelado hasta que alguien reabría y volvía a guardar cada receta a mano.
  for (const insumoId of idsActualizados) {
    await propagarCostoInsumo(insumoId, insumosBizId, client);
    if (Number(insumosBizId) !== Number(businessId)) await propagarCostoInsumo(insumoId, businessId, client);
  }
  return idsActualizados.length;
}

async function upsertPurchasesBatch(businessId, facturas, insumoMap, branchId = null) {
  if (!facturas?.length) return { inserted: 0, updated: 0, items: 0, batch_id: generateBatchId() };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await upsertPurchasesEnCliente(client, businessId, facturas, insumoMap, branchId);
    await client.query('COMMIT');
    return r;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Lo mismo dentro de una transacción ajena. source e insumosBizId solo los pasa la carga del Panel.
async function upsertPurchasesEnCliente(client, businessId, facturas, insumoMap, branchId = null, { source = null, insumosBizId = businessId } = {}) {
  const effectiveBatchId = generateBatchId();
  let inserted = 0, updated = 0, totalItems = 0;
  {
    // Candidatos a insumo_id de todo el batch, para pedir de una sola vez la
    // mediana histórica de cada uno (ver filtro de precio sospechoso abajo).
    const idsCandidatos = new Set();
    for (const factura of facturas) {
      for (const it of (factura?.items || [])) {
        const codigoMaxi = it.insumo != null ? Number(it.insumo) : null;
        const candidato = codigoMaxi != null ? insumoMap.get(codigoMaxi) : null;
        if (candidato) idsCandidatos.add(candidato);
      }
    }
    const medianas = await obtenerMedianasPrevias(client, businessId, [...idsCandidatos]);
    let matchesDescartados = 0;

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
            batch_id, branch_id, source,
            synced_at, updated_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,COALESCE($11,'maxi'),NOW(),NOW())
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
         effectiveBatchId, branchId ?? null, source]
      );

      const purchaseId = upsertRes.rows[0].id;
      const isInsert   = upsertRes.rows[0].is_insert;
      if (isInsert) inserted++; else updated++;

      // Anti-duplicado: MaxiRest manda. Si esa compra ya se había cargado a
      // mano por CSV (mismo proveedor y fecha), se quita la del CSV para que
      // no quede sumada dos veces (Comercio, 31/10/2026). Los ítems se borran
      // en cascada. Nunca la que se acaba de actualizar: si el CSV tenía el mismo
      // número de factura, el upsert cayó sobre esa fila, que sigue con source='csv'.
      if (fecha) {
        await client.query(
          `DELETE FROM purchases
            WHERE business_id = $1
              AND source = 'csv'
              AND proveedor_id IS NOT DISTINCT FROM $2
              AND fecha::date = $3::date
              AND COALESCE(branch_id, -1) = COALESCE($4, -1)
              AND id <> $5`,
          [businessId, proveedorId, fecha, branchId ?? null, purchaseId]
        );
      }

      await client.query('DELETE FROM purchase_items WHERE purchase_id = $1', [purchaseId]);

      for (const it of items) {
        const codigoMaxi = it.insumo != null ? Number(it.insumo) : null;
        let insumoId     = codigoMaxi != null ? (insumoMap.get(codigoMaxi) ?? null) : null;
        const itemFecha  = it.fecha ?? fecha;

        const cantidadTotal  = Number(it.cantidad ?? 0);
        const precioUnitario = Number(it.precio ?? 0);
        const factorNeto     = Number(it.neto ?? 0);

        // Filtro de precio sospechoso: un código de origen puede coincidir
        // por casualidad con el codigo_maxi de un insumo real (gastos
        // administrativos — luz, impuestos, comisiones — matcheando
        // mercadería real). Un salto de RATIO_PRECIO_SOSPECHOSO veces o más
        // contra la mediana ya pagada por ese insumo nunca es una suba de
        // precio real — se descarta el match, la línea queda sin insumo.
        // Una factura cargada en Lazarillo no tiene ese problema: el insumo lo eligió quien cargó y el
        // salto de precio ya se avisó en la carga ("×10 de la última compra"). Ahí no se descarta: si
        // no, la compra no aparecía en Recetas ni en costos (Diego 06/11/2026, Nalga en Comercio).
        if (insumoId && source !== 'lazarillo' && precioUnitario > 0 && medianas.has(insumoId)) {
          const mediana = medianas.get(insumoId);
          const ratio = Math.max(precioUnitario / mediana, mediana / precioUnitario);
          if (ratio >= RATIO_PRECIO_SOSPECHOSO) {
            insumoId = null;
            matchesDescartados++;
          }
        }

        await client.query(
          `INSERT INTO purchase_items
             (purchase_id, business_id, insumo_id, fecha,
              branch_id, cantidad, neto, precio, precio_total,
              iva_tasa, iva, iva_total_item,
              imp_int, imp_int_total, orden_compra, cpto_caja, referencia, source)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,COALESCE($18,'maxi'))`,
          [purchaseId, businessId, insumoId,
           itemFecha, it.sucursal ?? null,
           cantidadTotal, factorNeto, precioUnitario,
           it.preciotot ?? 0,
           it.iva_tasa ?? 0, it.iva ?? 0, it.iva_total ?? 0,
           it.imp_int ?? 0, it.imp_inttot ?? 0,
           it.orden_compra ?? 0, it.cptoCaja ?? 0, it.referencia ?? '', source]
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
    const preciosActualizados = await actualizarPreciosDeInsumos(client, { businessId, insumosBizId, insumoIds: [...insumoIdsConCompra] });
    return { inserted, updated, items: totalItems, preciosActualizados, matchesDescartados, batch_id: effectiveBatchId, insumoIds: [...insumoIdsConCompra] };
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

module.exports = { upsertPurchasesBatch, upsertPurchasesEnCliente, actualizarPreciosDeInsumos, facturaKeyPanel, upsertSuppliers, generateBatchId };