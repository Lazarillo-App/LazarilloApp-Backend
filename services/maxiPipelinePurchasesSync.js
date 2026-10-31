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
const { PDV_MAP } = require('./maxiPdvMap');

function facturaKeyDe(cod_cpb, numero1, numero2) {
  return `${String(cod_cpb ?? '').trim()}-${numero1}-${numero2}`;
}

// Comprobantes de GASTO administrativo (no mercadería): confirmado cruzando
// purchase_items ya ingresados — TODO comprobante cod_cpb='C' encontrado era
// un gasto (Contador, Mantenimiento, Administración redes sociales, Diseño
// Gráfico, etc.) cuyo "codigo" de MaxiRest coincidía por pura casualidad
// numérica con el codigo_maxi de un insumo real (ej. "Diseño Grafico" código
// 931 == "Barril Golden" código 931), pisándole precio_ref con el importe del
// gasto. 'N' tiene el mismo patrón (Plataforma Mercadopago, Librería). Estos
// comprobantes NUNCA deben buscar insumo — quedan sin stock asociado, igual
// que la mercadería sin detalle.
const TIPOS_GASTO = new Set(['C', 'N']);

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

// i25 trae `cantidad` en la unidad de EMBALAJE con que se cargó la línea
// (ej. "8.000 X6" = 8 packs de 6, no 8 unidades) — confirmado por Diego
// (MaxiRest) cruzando el informe impreso: la factura real de Coca 600 dice
// "8.000 X6" a $4.982,17 (precio POR PACK), no por unidad. El factor real
// ya llega automático en m0_listado_de_insumos_con_discontinuados
// (envase1/2/3 + neto1/2/3 por código, ej. X6→6) junto con i25/i80 — no
// hace falta pedirle nada nuevo, se cruza acá mismo.
// Devuelve Map<codigo, Map<envase, factor>>.
async function construirFactoresEnvase(schema) {
  const { rows } = await pool.query(
    `SELECT codigo, envase1, neto1, envase2, neto2, envase3, neto3
       FROM "${schema}".m0_listado_de_insumos_con_discontinuados`
  );
  const porCodigo = new Map();
  for (const r of rows) {
    const envases = new Map();
    for (const [envase, neto] of [[r.envase1, r.neto1], [r.envase2, r.neto2], [r.envase3, r.neto3]]) {
      const label = String(envase ?? '').trim();
      const factor = Number(neto);
      if (label && Number.isFinite(factor) && factor > 0) envases.set(label, factor);
    }
    if (envases.size) porCodigo.set(Number(r.codigo), envases);
  }
  return porCodigo;
}

// Factor real para una línea puntual — 1 si no hay envase cargado o no
// matchea ninguno del maestro (ya viene en unidad base, o es un insumo sin
// packs declarados).
function factorDeLinea(factoresPorCodigo, codigo, medida) {
  const envases = factoresPorCodigo.get(Number(codigo));
  if (!envases) return 1;
  const label = String(medida ?? '').trim();
  return envases.get(label) ?? 1;
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
    if (TIPOS_GASTO.has(String(f.cod_cpb ?? '').trim().toUpperCase())) continue;
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

  const factoresPorCodigo = await construirFactoresEnvase(schema);

  // Agrupar en facturas — misma forma que ya espera upsertPurchasesBatch.
  const porFactura = new Map();
  for (const f of filas) {
    const key = facturaKeyDe(f.cod_cpb, f.numero1, f.numero2);
    if (!porFactura.has(key)) {
      porFactura.set(key, { numero: key, proveedor: f.cod_pro, items: [] });
    }
    const esGasto = TIPOS_GASTO.has(String(f.cod_cpb ?? '').trim().toUpperCase());
    // Línea cargada POR CONCEPTO en MaxiRest (un gasto sin detalle de
    // insumos: impuestos, servicios, contador, comisiones…): el 25 la trae
    // con código = concepto de caja (cod_cga) y sin unidad de medida. Ese
    // código NO es un insumo: si coincide con el codigo_maxi de uno, la
    // línea se le pegaba (ej. "Servicio de Aguas" 206 → LATA PASO POMELO,
    // "Contribuciones SS 351" 771 → FOLIOS OFICIO). En 2026 Bar/Canchas:
    // 1.855 líneas con código = concepto, todas sin medida, y ninguna línea
    // de insumo real con código = concepto.
    const esConcepto = f.codigo != null && f.cod_cga != null
      && String(f.codigo).trim() === String(f.cod_cga).trim();

    // cantidad/neto vienen en unidad de EMBALAJE (ver comentario de
    // construirFactoresEnvase) — se convierten acá a unidad base ANTES de
    // guardar. El importe total de la línea (totalins) no cambia, es lo
    // que de verdad se pagó; solo se reparte entre más (o las mismas)
    // unidades.
    const factor = (esGasto || esConcepto) ? 1 : factorDeLinea(factoresPorCodigo, f.codigo, f.medida);
    const cantidadBase = Number(f.cantidad ?? 0) * factor;
    const netoBase = factor !== 1 && cantidadBase > 0
      ? Number(f.totalins ?? 0) / cantidadBase
      : f.neto;

    porFactura.get(key).items.push({
      insumo: (esGasto || esConcepto) ? null : f.codigo,
      fecha: f.fecha,
      cantidad: cantidadBase,
      neto: netoBase,          // precio unitario neto, ya en unidad base
      precio: netoBase,        // no hay un "precio" separado en i25 — se reusa neto como mejor referencia
      preciotot: f.totalins,   // el total pagado no cambia con la conversión
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

  // orden_maxi puede repetirse entre la tabla del año anterior y la del
  // actual (el pago de una factura puede fecharse meses después de la
  // factura y terminar exportado en las dos) — "ON CONFLICT DO UPDATE" no
  // admite el mismo conflict target dos veces en una sola sentencia, así
  // que se deduplica por orden ANTES de armar los lotes (se queda con la
  // última ocurrencia, que es la más reciente dentro de este fetch).
  const porOrden = new Map();
  for (const f of filas) {
    const orden = f.orden != null ? Number(f.orden) : null;
    if (!Number.isFinite(orden)) continue;
    porOrden.set(orden, { ...f, orden });
  }
  const filasUnicas = [...porOrden.values()];

  // Bulk (UNNEST), no una query por fila — con ~2500+ pagos, una fila a la
  // vez tardaba minutos y en una corrida se cortó la conexión a mitad de
  // camino (cada INSERT individual tardaba 500-1400ms). En lotes de 500 es
  // una sola ida y vuelta por lote.
  const LOTE = 500;
  let insertados = 0;
  for (let i = 0; i < filasUnicas.length; i += LOTE) {
    const lote = filasUnicas.slice(i, i + LOTE);
    if (!lote.length) continue;

    const businessIds = lote.map(() => businessId);
    const facturaKeys = lote.map((f) => facturaKeyDe(f.cod_cpb, f.prefijo, f.numero));
    const pdvs = lote.map(() => pdv);
    const ordenes = lote.map((f) => f.orden);
    const formasPago = lote.map((f) => f.pago ?? null);
    const importes = lote.map((f) => f.importe ?? null);
    const fechasPago = lote.map((f) => f.fecha_pago ?? null);
    const chequeNumeros = lote.map((f) => f.numero_val ?? null);
    const chequeFechasVto = lote.map((f) => f.fecha_val ?? null);
    const chequeImportes = lote.map((f) => f.imp_val ?? null);
    const bancoCodigos = lote.map((f) => f.cod_ban ?? null);
    const bancoNombres = lote.map((f) => f.nom_ban ?? null);
    const codCgas = lote.map((f) => f.cod_cga ?? null);
    const nomCgas = lote.map((f) => f.nom_cga ?? null);
    const codRgas = lote.map((f) => f.cod_rga ?? null);
    const nomRgas = lote.map((f) => f.nom_rga ?? null);
    const codCtgs = lote.map((f) => f.cod_ctg ?? null);
    const nomCtgs = lote.map((f) => f.nom_ctg ?? null);

    const r = await pool.query(
      `WITH datos AS (
         SELECT * FROM UNNEST(
           $1::bigint[], $2::text[], $3::text[], $4::bigint[], $5::text[],
           $6::numeric[], $7::date[], $8::bigint[], $9::text[], $10::numeric[],
           $11::bigint[], $12::text[], $13::bigint[], $14::text[],
           $15::bigint[], $16::text[], $17::bigint[], $18::text[]
         ) AS t(business_id, factura_key, pdv, orden_maxi, forma_pago, importe, fecha_pago,
                cheque_numero, cheque_fecha_vto, cheque_importe, banco_codigo, banco_nombre,
                cod_cga, nom_cga, cod_rga, nom_rga, cod_ctg, nom_ctg)
       )
       INSERT INTO purchase_payments (
         business_id, purchase_id, factura_key, pdv, orden_maxi, forma_pago,
         importe, fecha_pago, cheque_numero, cheque_fecha_vto, cheque_importe,
         banco_codigo, banco_nombre, cod_cga, nom_cga, cod_rga, nom_rga, cod_ctg, nom_ctg,
         synced_at
       )
       SELECT
         d.business_id, p.id, d.factura_key, d.pdv, d.orden_maxi, d.forma_pago,
         d.importe, d.fecha_pago, d.cheque_numero, d.cheque_fecha_vto, d.cheque_importe,
         d.banco_codigo, d.banco_nombre, d.cod_cga, d.nom_cga, d.cod_rga, d.nom_rga, d.cod_ctg, d.nom_ctg,
         NOW()
       FROM datos d
       LEFT JOIN purchases p ON p.business_id = d.business_id AND p.factura_key = d.factura_key
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
        businessIds, facturaKeys, pdvs, ordenes, formasPago,
        importes, fechasPago, chequeNumeros, chequeFechasVto, chequeImportes,
        bancoCodigos, bancoNombres, codCgas, nomCgas, codRgas, nomRgas, codCtgs, nomCtgs,
      ]
    );
    insertados += r.rowCount;
  }

  return { insertados, dryRun };
}

module.exports = { syncComprasDeNegocio, listarCodigosSinInsumo, PDV_MAP };
