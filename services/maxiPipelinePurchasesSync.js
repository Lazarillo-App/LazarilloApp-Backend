// services/maxiPipelinePurchasesSync.js
//
// Ingesta de Compras desde el pipeline nuevo del colega (schemas
// `container`/`comercio`, tablas i25/i80 — ver memoria
// maxirest-sync-schema-147 y el plan de "pipeline completo de MaxiRest").
// Reemplaza la Fase 1 vieja (maxi_purchases_staging / purchasesStagingSync.js),
// que dependía del espejo crudo `maxirest_14536_ramos`, ahora congelado.
//
// i25_compras_detalle_de_compras_AÑO: una fila por línea de insumo de una
// factura de compra. Se agrupa en facturas (misma forma que ya espera
// purchasesStore.upsertPurchasesBatch, sin tocar esa función) y se sube con
// el mismo mecanismo de siempre (incluida la cascada de costeo con reglas de
// bonificación).
//
// i80_compras_detalle_de_pagos_AÑO: una fila por PAGO de una factura (puede
// haber varios pagos por factura — cuotas, métodos distintos). Va a la tabla
// nueva purchase_payments (ver create-purchase-payments.js), vinculada a la
// factura por la misma clave. Por ahora es solo almacenamiento, sin UI.
//
// Clave de factura: confirmado cruzando i25 y i80 a mano — el número real de
// comprobante son DOS números (i25: numero1+numero2, i80: prefijo+numero),
// no uno solo. cod_cpb + numero1 + numero2 identifica la factura.
'use strict';

const pool = require('../config/db');
const { buildInsumoMap, resolveCredsBizId } = require('../controllers/purchasesController');
const { upsertPurchasesBatch } = require('./purchasesStore');

// pdv (columna de texto en i25/i80) → en qué schema vive y qué negocio de
// Lazarillo es. San Justo (FCSANJUSTO) todavía no sube datos — se agrega acá
// en cuanto el colega confirme que esa PC está sincronizando.
const PDV_MAP = {
  BAR: { schema: 'container', businessId: 147 },
  FCRAMOS: { schema: 'container', businessId: 204 },
  COMERCIO: { schema: 'comercio', businessId: 210 },
};

function facturaKeyDe(cod_cpb, numero1, numero2) {
  return `${String(cod_cpb ?? '').trim()}-${numero1}-${numero2}`;
}

// Las tablas son "prefijo_AÑO" y AÑO rota cada enero (conviven el actual y el
// anterior) — se resuelven por información real del schema, nunca
// hardcodeadas, para no romperse solas en cada Año Nuevo.
async function resolverTablasDelAnio(schema, prefijo) {
  // El LIKE es solo un pre-filtro rápido (el "_" de prefijo matchea cualquier
  // carácter en LIKE, no hace falta escaparlo acá) — el regex de abajo es la
  // guarda real, exige el patrón exacto prefijo_YYYY.
  const { rows } = await pool.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = $1 AND table_name LIKE $2
      ORDER BY table_name DESC`,
    [schema, `${prefijo}_%`]
  );
  return rows
    .map((r) => r.table_name)
    .filter((t) => new RegExp(`^${prefijo}_\\d{4}$`).test(t));
}

function resolverPdv(businessId) {
  const entry = Object.entries(PDV_MAP).find(([, v]) => v.businessId === Number(businessId));
  return entry ? { pdv: entry[0], schema: entry[1].schema } : null;
}

async function obtenerFilasI25(pdv, schema) {
  const tablas25 = await resolverTablasDelAnio(schema, 'i25_compras_detalle_de_compras');
  if (!tablas25.length) return [];
  let filas = [];
  for (const tabla of tablas25) {
    const { rows } = await pool.query(
      `SELECT * FROM "${schema}"."${tabla}" WHERE pdv = $1`,
      [pdv]
    );
    filas = filas.concat(rows);
  }
  return filas;
}

// Diagnóstico: qué códigos de insumo de MaxiRest no matchean ningún insumo
// de Lazarillo (insumos.codigo_maxi) — para revisar antes de aplicar si son
// insumos que faltan crear, o un problema de datos (codigo_maxi mal cargado).
async function listarCodigosSinInsumo(businessId) {
  const resuelto = resolverPdv(businessId);
  if (!resuelto) return { ok: false, error: `Negocio ${businessId} no está en PDV_MAP todavía` };
  const { pdv, schema } = resuelto;

  const filas = await obtenerFilasI25(pdv, schema);
  const credsBizId = await resolveCredsBizId(businessId);
  const insumoMap = await buildInsumoMap(credsBizId);

  const porCodigo = new Map();
  for (const f of filas) {
    if (f.codigo != null && insumoMap.has(Number(f.codigo))) continue;
    const key = String(f.codigo);
    if (!porCodigo.has(key)) {
      porCodigo.set(key, { codigo: f.codigo, nombre: f.nombre, rubro: f.nom_cga, lineas: 0 });
    }
    porCodigo.get(key).lineas++;
  }
  return { ok: true, codigos: [...porCodigo.values()].sort((a, b) => b.lineas - a.lineas) };
}

async function syncComprasDeNegocio(businessId, { dryRun = false } = {}) {
  const resuelto = resolverPdv(businessId);
  if (!resuelto) {
    return { ok: false, error: `Negocio ${businessId} no está en PDV_MAP todavía` };
  }
  const { pdv, schema } = resuelto;

  const filas = await obtenerFilasI25(pdv, schema);
  if (!filas.length) {
    return { ok: true, facturas: 0, items: 0, sinInsumo: 0, pagos: 0, dryRun };
  }

  // Agrupar en facturas — misma forma que ya espera upsertPurchasesBatch.
  const porFactura = new Map();
  for (const f of filas) {
    const key = facturaKeyDe(f.cod_cpb, f.numero1, f.numero2);
    if (!porFactura.has(key)) {
      porFactura.set(key, { numero: key, proveedor: f.cod_pro, items: [] });
    }
    porFactura.get(key).items.push({
      insumo: f.codigo,
      fecha: f.fecha,
      cantidad: f.cantidad,
      neto: f.neto,           // precio unitario neto (confirmado: neto * cantidad = totalins)
      precio: f.neto,         // no hay un "precio" separado en i25 — se reusa neto como mejor referencia
      preciotot: f.totalins,
      iva_tasa: f.tasa,
      iva: f.iva,
      iva_total: f.ivatot,
      imp_int: f.imp_int,
      imp_inttot: f.impinttot,
      percep: f.percep,
      cptoCaja: f.cod_cga,
      referencia: f.nom_cga,
    });
  }
  const facturas = [...porFactura.values()];

  const credsBizId = await resolveCredsBizId(businessId);
  const insumoMap = await buildInsumoMap(credsBizId);

  let sinInsumo = 0;
  for (const f of facturas) {
    for (const it of f.items) {
      if (it.insumo == null || !insumoMap.has(Number(it.insumo))) sinInsumo++;
    }
  }

  const pagosResultado = await syncPagosDeNegocio(businessId, pdv, schema, { dryRun });

  if (dryRun) {
    return { ok: true, facturas: facturas.length, items: filas.length, sinInsumo, pagos: pagosResultado, dryRun };
  }

  const resultadoCompras = await upsertPurchasesBatch(businessId, facturas, insumoMap, null);

  return {
    ok: true,
    facturas: facturas.length,
    items: filas.length,
    sinInsumo,
    compras: resultadoCompras,
    pagos: pagosResultado,
    dryRun,
  };
}

async function syncPagosDeNegocio(businessId, pdv, schema, { dryRun = false } = {}) {
  const tablas80 = await resolverTablasDelAnio(schema, 'i80_compras_detalle_de_pagos');
  if (!tablas80.length) return { insertados: 0, dryRun };

  let filas = [];
  for (const tabla of tablas80) {
    const { rows } = await pool.query(
      `SELECT * FROM "${schema}"."${tabla}" WHERE pdv = $1`,
      [pdv]
    );
    filas = filas.concat(rows);
  }
  if (!filas.length) return { insertados: 0, dryRun };

  if (dryRun) return { insertados: filas.length, dryRun };

  let insertados = 0;
  for (const f of filas) {
    const orden = f.orden != null ? Number(f.orden) : null;
    if (!Number.isFinite(orden)) continue;
    const facturaKey = facturaKeyDe(f.cod_cpb, f.prefijo, f.numero);

    await pool.query(
      `INSERT INTO purchase_payments (
         business_id, purchase_id, factura_key, pdv, orden_maxi, forma_pago,
         importe, fecha_pago, cheque_numero, cheque_fecha_vto, cheque_importe,
         banco_codigo, banco_nombre, cod_cga, nom_cga, cod_rga, nom_rga, cod_ctg, nom_ctg,
         synced_at
       )
       VALUES (
         $1,
         (SELECT id FROM purchases WHERE business_id = $1 AND factura_key = $2 LIMIT 1),
         $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
         NOW()
       )
       ON CONFLICT (business_id, orden_maxi) DO UPDATE SET
         purchase_id      = EXCLUDED.purchase_id,
         factura_key      = EXCLUDED.factura_key,
         forma_pago       = EXCLUDED.forma_pago,
         importe          = EXCLUDED.importe,
         fecha_pago       = EXCLUDED.fecha_pago,
         cheque_numero    = EXCLUDED.cheque_numero,
         cheque_fecha_vto = EXCLUDED.cheque_fecha_vto,
         cheque_importe   = EXCLUDED.cheque_importe,
         banco_codigo     = EXCLUDED.banco_codigo,
         banco_nombre     = EXCLUDED.banco_nombre,
         cod_cga = EXCLUDED.cod_cga, nom_cga = EXCLUDED.nom_cga,
         cod_rga = EXCLUDED.cod_rga, nom_rga = EXCLUDED.nom_rga,
         cod_ctg = EXCLUDED.cod_ctg, nom_ctg = EXCLUDED.nom_ctg,
         synced_at = NOW()`,
      [
        businessId, facturaKey, pdv, orden, f.pago ?? null,
        f.importe ?? null, f.fecha_pago ?? null,
        f.numero_val ?? null, f.fecha_val ?? null, f.imp_val ?? null,
        f.cod_ban ?? null, f.nom_ban ?? null,
        f.cod_cga ?? null, f.nom_cga ?? null,
        f.cod_rga ?? null, f.nom_rga ?? null,
        f.cod_ctg ?? null, f.nom_ctg ?? null,
      ]
    );
    insertados++;
  }

  return { insertados, dryRun };
}

module.exports = { syncComprasDeNegocio, listarCodigosSinInsumo, PDV_MAP };
