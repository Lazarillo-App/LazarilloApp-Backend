// Puente entre la carga de facturas del Panel y los costos de Lazarillo.
//
// El Panel guarda en gestion_compras / gestion_detalle_compras; los costos salen de purchases /
// purchase_items → insumos.precio_ref → recetas. Acá una factura del Panel entra a esas tablas por
// la MISMA función que usa MaxiRest (upsert de purchasesStore): mismo modo de costeo, bonificaciones,
// filtro de precios sospechosos y cascada a las recetas. Va en la transacción de la carga: o queda
// la factura con sus costos, o no queda nada.
//
// Diferencias con lo que trae MaxiRest, todas a propósito:
//  - Clave de factura: "A-2-69930~<proveedor>" (y "~<fecha>" en tickets). purchases es único por
//    negocio + clave, sin proveedor: con la clave pelada, la factura A-1-100 de otro proveedor pisaría
//    a esta. El "~…" no se muestra (split_part en las lecturas).
//  - El tipo de renglón lo dijo quien cargó: un insumo en una factura C es un insumo. El filtro de
//    MaxiRest por letra existe porque ahí el código de un gasto coincide con el de un insumo.
//  - Notas de crédito: el armado guarda las líneas en positivo; acá van en negativo, como una
//    devolución, para que no cuenten como una compra.
'use strict';

const { upsertPurchasesEnCliente, actualizarPreciosDeInsumos, facturaKeyPanel } = require('../../purchasesStore');
const { recalcularBonificaciones } = require('../../bonificacionesService');
const { schemaDeNegocio } = require('../../maxiPdvMap');
const { GV_CODIGO } = require('../gastos-varios/periodo');

const r2 = (n) => Math.round(n * 100) / 100;
const r4 = (n) => Math.round(n * 10000) / 10000;
const IDENT_SEGURO = /^[a-z_][a-z0-9_]*$/i;

// suppliers.id es numérico. Los proveedores creados en el Panel tienen código "L<n>": se les da un id
// fuera del rango de los códigos de MaxiRest, así aparecen con su nombre sin chocar con ninguno.
const BASE_PROVEEDOR_PANEL = 9000000000;
function proveedorNumerico(codigo) {
  const c = String(codigo ?? '').trim();
  if (/^\d+$/.test(c)) return Number(c);
  const m = c.match(/^L(\d+)$/);
  return m ? BASE_PROVEEDOR_PANEL + Number(m[1]) : null;
}

// Clave de la factura a partir del comprobante guardado ("A000200069930", "NC0004...", "Z...").
function claveDesdeComprobante(comprobante, codigo, fechaISO) {
  const m = String(comprobante ?? '').toUpperCase().match(/^(NC[ABC]?|[A-Z])(\d{4})(\d{8})$/);
  if (!m) return null;
  return facturaKeyPanel({ letra: m[1], prefijo: m[2], numero: m[3], codigo, fecha: fechaISO });
}

const facturaAplica = (codigoProveedor) => codigoProveedor !== GV_CODIGO;

// Unidades base por envase, del mismo maestro que usa MaxiRest. Sin maestro: Map vacío, factor 1.
async function leerFactoresEnvase(client, businessId, organizationId) {
  const { rows } = await client.query(
    `SELECT o.esquema FROM gestion_render_origenes o
       JOIN app_businesses b ON b.id = o.business_id
      WHERE o.activo AND b.organization_id = $1
      ORDER BY (o.business_id = $2) DESC LIMIT 1`,
    [organizationId, businessId]
  );
  const esquema = rows[0]?.esquema ?? schemaDeNegocio(businessId);
  if (!esquema || !IDENT_SEGURO.test(esquema)) return new Map();
  // Se verifica antes: dentro de una transacción, consultar una tabla que no existe la aborta entera.
  const tabla = `"${esquema}".m0_listado_de_insumos_con_discontinuados`;
  const { rows: existe } = await client.query('SELECT to_regclass($1) AS t', [tabla]);
  if (!existe[0]?.t) return new Map();
  const { rows: m0 } = await client.query(
    `SELECT codigo, envase1, neto1, envase2, neto2, envase3, neto3 FROM ${tabla}`
  );
  const porCodigo = new Map();
  for (const r of m0) {
    const envases = new Map();
    for (const [envase, neto] of [[r.envase1, r.neto1], [r.envase2, r.neto2], [r.envase3, r.neto3]]) {
      const etiqueta = String(envase ?? '').trim();
      const factor = Number(neto);
      if (etiqueta && Number.isFinite(factor) && factor > 0) envases.set(etiqueta, factor);
    }
    if (envases.size) porCodigo.set(Number(r.codigo), envases);
  }
  return porCodigo;
}

function factorDe(factores, codigo, medida) {
  const envases = factores.get(Number(codigo));
  if (!envases) return 1;
  return envases.get(String(medida ?? '').trim()) ?? 1;
}

// Pura: arma lo que espera el upsert, una factura por sucursal (como un PDV de MaxiRest).
function armarFacturasCosteo({ armado, branchDe, factores, signo, claveFactura, proveedorId }) {
  const porSucursal = new Map();
  const entrada = (branchId) => {
    const k = branchId ?? null;
    if (!porSucursal.has(k)) porSucursal.set(k, { branchId: k, factura: { numero: claveFactura, proveedor: proveedorId, items: [] }, impLineas: 0 });
    return porSucursal.get(k);
  };

  for (const l of armado.lineas) {
    const e = entrada(branchDe.get(l.puntoDeVentaId));
    const codigoInsumo = l.esInsumo && /^\d+$/.test(String(l.codigo ?? '').trim()) ? String(l.codigo).trim() : null;
    const factor = l.esInsumo && codigoInsumo ? factorDe(factores, codigoInsumo, l.medida) : 1;
    const unidades = Number(l.cantidad ?? 0) * factor;
    const neto = Number(l.totalIns ?? 0);
    const unitario = unidades > 0 ? r4(neto / unidades) : 0;
    const imp = Number(l.impNtTot ?? 0);
    e.impLineas = r2(e.impLineas + imp * signo);
    e.factura.items.push({
      insumo: codigoInsumo,
      nombre: l.nombre,
      esInsumo: !!l.esInsumo,
      fecha: l.fecha,
      cantidad: r4(unidades * signo),
      neto: unitario,
      precio: unitario,
      preciotot: r2(neto * signo),
      iva_tasa: Number(l.tasa ?? 0),
      iva: unidades > 0 ? r4(Number(l.ivaTot ?? 0) / unidades) : 0,
      iva_total: r2(Number(l.ivaTot ?? 0) * signo),
      imp_int: unidades > 0 ? r4(imp / unidades) : 0,
      imp_inttot: r2(imp * signo),
      percep: 0,
      cptoCaja: /^\d+$/.test(String(l.codCga ?? '').trim()) ? Number(l.codCga) : 0,
      referencia: l.nomCga ?? '',
      sucursal: branchDe.get(l.puntoDeVentaId) ?? null,
    });
  }

  // Percepciones e impuestos internos generales viven en las filas: van al primer renglón de cada
  // sucursal, así el total de purchases da igual al de la factura.
  const lista = [...porSucursal.values()];
  const extras = new Map();
  for (const f of armado.filas) {
    const k = branchDe.get(f.puntoDeVentaId) ?? null;
    const x = extras.get(k) ?? { percep: 0, impInt: 0 };
    x.percep = r2(x.percep + Number(f.per1 ?? 0) + Number(f.per2 ?? 0) + Number(f.per3 ?? 0));
    x.impInt = r2(x.impInt + Number(f.impInt ?? 0));
    extras.set(k, x);
  }
  for (const [k, x] of extras) {
    const e = porSucursal.get(k) ?? lista[0];
    if (!e?.factura.items.length) continue;
    const it = e.factura.items[0];
    it.percep = r2(Number(it.percep ?? 0) + x.percep);
    it.imp_inttot = r2(it.imp_inttot + r2(x.impInt - (porSucursal.has(k) ? e.impLineas : 0)));
  }
  return lista;
}

async function resolverBizInsumos(client, businessId) {
  const { rows } = await client.query('SELECT created_from, organization_id FROM app_businesses WHERE id = $1', [businessId]);
  const biz = rows[0];
  if (!biz || biz.created_from !== 'from_group' || !biz.organization_id) return businessId;
  const { rows: raiz } = await client.query(
    `SELECT id FROM app_businesses
      WHERE organization_id = $1 AND (created_from IS NULL OR created_from = 'manual' OR created_from = 'onboarding')
      ORDER BY id ASC LIMIT 1`,
    [biz.organization_id]
  );
  return Number(raiz[0]?.id ?? businessId);
}

async function mapaInsumos(client, bizInsumos) {
  const { rows } = await client.query(
    `SELECT id, codigo_maxi::bigint AS codigo_maxi FROM insumos
      WHERE business_id = $1 AND codigo_maxi IS NOT NULL AND codigo_maxi ~ '^[0-9]+$'`,
    [bizInsumos]
  );
  return new Map(rows.map((r) => [Number(r.codigo_maxi), Number(r.id)]));
}

// Los insumos con bonificación aceptada no los toca el cálculo común: tienen la suya.
async function cerrarBonificaciones(client, businessId, ids) {
  if (ids.length) await recalcularBonificaciones(businessId, ids, client);
}

// Saca la factura de los costos y devuelve los insumos que tenía (hay que recalcularlos).
async function sacar(client, businessId, claveFactura) {
  const { rows } = await client.query(
    `SELECT DISTINCT pi.insumo_id FROM purchase_items pi JOIN purchases p ON p.id = pi.purchase_id
      WHERE p.business_id = $1 AND p.factura_key = $2 AND p.source = 'lazarillo' AND pi.insumo_id IS NOT NULL`,
    [businessId, claveFactura]
  );
  await client.query(
    `DELETE FROM purchase_items WHERE purchase_id IN
       (SELECT id FROM purchases WHERE business_id = $1 AND factura_key = $2 AND source = 'lazarillo')`,
    [businessId, claveFactura]
  );
  await client.query(`DELETE FROM purchases WHERE business_id = $1 AND factura_key = $2 AND source = 'lazarillo'`, [businessId, claveFactura]);
  return rows.map((r) => Number(r.insumo_id));
}

// Alta o edición. `anterior`: { comprobante, codigo, fecha } de lo que había antes de editar.
async function pasarFacturaACostos(tx, ctx, p, anterior = null) {
  const client = tx.cliente;
  const { businessId, organizationId } = ctx;
  const { armado, proveedorCodigo, f } = p;
  const sinCambios = { aplicada: false, precios: 0, sinVincular: [], descartados: 0 };

  const bizInsumos = await resolverBizInsumos(client, businessId);
  const claveAnterior = anterior ? claveDesdeComprobante(anterior.comprobante, anterior.codigo, anterior.fecha) : null;
  const sacados = claveAnterior ? await sacar(client, businessId, claveAnterior) : [];

  const cerrar = async (resultado, tocados = []) => {
    const pendientes = sacados.filter((id) => !tocados.includes(id));
    if (pendientes.length) await actualizarPreciosDeInsumos(client, { businessId, insumosBizId: bizInsumos, insumoIds: pendientes });
    await cerrarBonificaciones(client, businessId, [...new Set([...tocados, ...sacados])]);
    return resultado;
  };

  if (!facturaAplica(proveedorCodigo) || !armado.filas.length) return cerrar(sinCambios);

  const comprobante = armado.filas[0].comprobante;
  const claveFactura = claveDesdeComprobante(comprobante, proveedorCodigo, f.fecha);
  if (!claveFactura) return cerrar(sinCambios);
  const proveedorId = proveedorNumerico(proveedorCodigo);

  // ¿MaxiRest ya trajo esta misma factura a los costos? Entonces no se suma otra vez.
  if (proveedorId != null) {
    const base = claveFactura.split('~')[0];
    const { rows: yaEsta } = await client.query(
      `SELECT 1 FROM purchases
        WHERE business_id = $1 AND source IS DISTINCT FROM 'lazarillo' AND proveedor_id = $2
          AND regexp_replace(regexp_replace(UPPER(factura_key), '^NC[ABC]?', 'NC'), '-0+(?=[0-9])', '-', 'g') = $3
          AND ($4::boolean OR fecha::date = $5::date)
        LIMIT 1`,
      [businessId, proveedorId, base, !/^Z/.test(base), f.fecha]
    );
    if (yaEsta.length) return cerrar({ ...sinCambios, yaEnMaxirest: true });
  }

  if (proveedorId != null) {
    const { rows: prov } = await client.query(
      'SELECT nombre, razon, cuit FROM gestion_proveedores WHERE organization_id = $1 AND codigo = $2',
      [organizationId, proveedorCodigo]
    );
    await client.query(
      `INSERT INTO suppliers (id, business_id, nombre, razon_social, cuit, updated_at) VALUES ($1,$2,$3,$4,$5,NOW())
       ON CONFLICT (business_id, id) DO NOTHING`,
      [proveedorId, bizInsumos, p.nombreProv ?? prov[0]?.nombre ?? null, prov[0]?.razon ?? null, prov[0]?.cuit ?? null]
    );
  }

  const insumoMap = await mapaInsumos(client, bizInsumos);
  const factores = await leerFactoresEnvase(client, businessId, organizationId);
  const signo = /^NC/.test(comprobante.toUpperCase()) ? -1 : 1;
  const porSucursal = armarFacturasCosteo({ armado, branchDe: p.branchDe, factores, signo, claveFactura, proveedorId });

  const sinVincular = new Set();
  let precios = 0;
  let descartados = 0;
  const tocados = new Set();
  for (const { branchId, factura } of porSucursal) {
    for (const it of factura.items) {
      if (it.esInsumo && (it.insumo == null || !insumoMap.has(Number(it.insumo)))) sinVincular.add(it.nombre);
    }
    const r = await upsertPurchasesEnCliente(client, businessId, [factura], insumoMap, branchId, { source: 'lazarillo', insumosBizId: bizInsumos });
    precios += r.preciosActualizados ?? 0;
    descartados += r.matchesDescartados ?? 0;
    for (const id of r.insumoIds ?? []) tocados.add(id);
  }
  return cerrar({ aplicada: true, precios, sinVincular: [...sinVincular], descartados }, [...tocados]);
}

// Borrado: la factura deja de contar y los insumos vuelven a su compra anterior.
async function sacarFacturaDeCostos(tx, { businessId }, { comprobante, codigo, fecha }) {
  const client = tx.cliente;
  const clave = claveDesdeComprobante(comprobante, codigo, fecha);
  if (!clave) return { aplicada: false };
  const bizInsumos = await resolverBizInsumos(client, businessId);
  const ids = await sacar(client, businessId, clave);
  if (ids.length) {
    await actualizarPreciosDeInsumos(client, { businessId, insumosBizId: bizInsumos, insumoIds: ids });
    await cerrarBonificaciones(client, businessId, ids);
  }
  return { aplicada: ids.length > 0, insumos: ids.length };
}

module.exports = { pasarFacturaACostos, sacarFacturaDeCostos, armarFacturasCosteo, proveedorNumerico, claveDesdeComprobante, BASE_PROVEEDOR_PANEL };
