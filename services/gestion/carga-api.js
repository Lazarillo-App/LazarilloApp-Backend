// Carga manual del Panel, portada de lazarillo_gestion: facturas (app/api/facturas/*,
// lib/facturas/{guardar,alta,leer-db}), gastos varios, ventas manuales, conceptos y medios de pago.
//
// Tenancy: una factura cargada es del negocio activo. Donde gestion decía PDV acá hay un "lugar"
// del negocio, con un id entero para el payload: negativo = la principal del negocio (-business_id),
// positivo = esa sucursal (branch_id). El reparto entre negocios todavía no se ofrece: pide permisos
// sobre los dos y el motor de apertura.
//
// Pendiente del bloque de apertura: en gestion, después de guardar se reaplican las reglas activas
// (reaplicarReglasActivas). Hoy no hay reglas cargadas; cuando se porte el motor va acá.
'use strict';

const { randomUUID } = require('crypto');
const { z } = require('zod');
const { sql, db } = require('./db');
const { armarFactura, comprobanteDe, facturaSchema, CONCEPTO_PERCEPCION, ORIGEN_LAZARILLO, TIPOS_COMPROBANTE } = require('./facturas/armar');
const { facturaDesdeFilas } = require('./facturas/leer');
const { unirInsumos } = require('./facturas/insumos');
const { normalizarComprobante, esTicket } = require('./facturas/saltear-lazarillo');
const { GV_CODIGO, GV_NOMBRE, GV_PREFIJO, siguienteNumeroGV } = require('./gastos-varios/periodo');
const { itemSchema, claveIngreso, PREFIJO_MANUAL, COD_COBRO_MANUAL } = require('./ventas-manuales/carga');
const { conceptoPropioSchema, esPropio, proximoCodigoLazarillo } = require('./conceptos/abm');
const { medioSchema, mismoNombre } = require('./medios-pago/abm');
const { claveFactura, imputarFacturas, combinarPagos, numeroPago } = require('./pagos-proveedor/imputar');
const { leerInsumos, renderConfigurado } = require('./render/db');
const { ErrorDatos } = require('./dashboard/resultados-api');

const rechazo = (mensaje, status = 400, extra) => {
  const e = new ErrorDatos(mensaje);
  e.status = status;
  if (extra) e.extra = extra;
  return e;
};
const r2 = (n) => Math.round(n * 100) / 100;
const iso = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const pesos = (n) => `$ ${n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ── Lugares del negocio (principal + sucursales) ────────────────────────────────
const idLugar = (businessId, branchId) => (branchId != null ? Number(branchId) : -Number(businessId));

async function obtenerLugares(cliente, businessId) {
  const negocio = await cliente.one(sql`SELECT id, name FROM app_businesses WHERE id = ${businessId}`);
  // La sucursal marcada is_main es la principal (branch_id NULL en los datos): no va aparte.
  const sucursales = await cliente.many(sql`
    SELECT id, name FROM app_branches
    WHERE business_id = ${businessId} AND NOT COALESCE((props->>'is_main')::boolean, false)
    ORDER BY name`);
  return [
    { id: idLugar(businessId, null), localId: Number(businessId), branchId: null, nombre: negocio?.name ?? 'Principal' },
    ...sucursales.map((s) => ({ id: Number(s.id), localId: Number(businessId), branchId: Number(s.id), nombre: s.name })),
  ];
}

// ── Actividad ───────────────────────────────────────────────────────────────────
async function registrarActividad(tx, a) {
  await tx.execute(sql`
    INSERT INTO gestion_actividad (organization_id, business_id, tipo, accion, descripcion, "refId", usuario, datos)
    VALUES (${a.organizationId}, ${a.businessId}, ${a.tipo}, ${a.accion}, ${a.descripcion}, ${a.refId ?? null}, ${a.usuario ?? null},
            ${a.datos ? JSON.stringify(a.datos) : null}::jsonb)`);
}

function descripcionFactura(p) {
  const tipo = p.f.tipo === 'Ticket' ? 'Tic' : p.f.tipo;
  const comp = `${tipo} ${p.f.prefijo.padStart(4, '0')}-${p.f.numero.padStart(8, '0')}`;
  return `${p.nombreProv}\n${[comp, p.lugar, pesos(p.total)].filter(Boolean).join(' · ')}`;
}

// ── Preparar y guardar una factura ─────────────────────────────────────────────
async function prepararFactura(cliente, { organizationId, businessId }, body) {
  const parsed = facturaSchema.safeParse(body);
  if (!parsed.success) throw rechazo('Datos inválidos', 400, { detalle: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
  const f = parsed.data;
  const proveedor = await cliente.one(sql`
    SELECT id, codigo, nombre, razon FROM gestion_proveedores WHERE organization_id = ${organizationId} AND id = ${f.proveedorId}`);
  if (!proveedor) throw rechazo('Proveedor inexistente');
  const lugares = await obtenerLugares(cliente, businessId);
  const usados = new Set(f.registros.flatMap((r) => [r.puntoDeVentaId, ...(r.reparto ?? []).map((x) => x.puntoDeVentaId)]));
  if ([...usados].some((id) => !lugares.some((p) => p.id === id))) throw rechazo('Sucursal inexistente');
  const codigos = [...new Set([...f.registros.map((r) => r.conceptoCodigo), ...f.percepciones.map((p) => CONCEPTO_PERCEPCION[p.tipo])])];
  const conceptos = await cliente.many(sql`
    SELECT codigo, nombre FROM gestion_conceptos_caja WHERE organization_id = ${organizationId} AND codigo = ANY(${codigos}::text[])`);
  const faltan = codigos.filter((c) => !conceptos.some((x) => x.codigo === c));
  if (faltan.length) throw rechazo(`Concepto de caja inexistente: ${faltan.join(', ')}`);
  let armado;
  try {
    armado = armarFactura(f, { proveedor: { id: proveedor.id, codigo: proveedor.codigo }, pdvs: lugares, conceptos });
  } catch (err) {
    throw rechazo(err instanceof Error ? err.message : 'No se pudo armar la factura');
  }
  if (!armado.filas.length) throw rechazo('La factura no tiene importe');
  const branchDe = new Map(lugares.map((l) => [l.id, l.branchId]));
  return { f, armado, branchDe, lugares, proveedorCodigo: proveedor.codigo, nombreProv: proveedor.nombre ?? proveedor.razon ?? proveedor.codigo };
}

async function insertarArmado(tx, businessId, p) {
  const { armado, nombreProv, branchDe } = p;
  await tx.execute(sql`
    INSERT INTO gestion_compras (
      business_id, branch_id, "rowId", comprobante, "codCga", concepto, fecha, codigo, proveedor, detalle, observac,
      importe, "importeTrabajado", "impInt", per1, per2, per3, "proveedorId", "conceptoCodigo", "esBloqueado", origen
    ) VALUES ${sql.join(armado.filas.map((x) => sql`(
      ${businessId}, ${branchDe.get(x.puntoDeVentaId)}::bigint, ${x.rowId}, ${x.comprobante}, ${x.codCga}, ${x.concepto}, ${x.fecha}::date, ${x.codigo}, ${nombreProv}, ${x.detalle}, ${x.observac},
      ${x.importe}::numeric, ${x.importe}::numeric, ${x.impInt}::numeric, ${x.per1}::numeric, ${x.per2}::numeric, ${x.per3}::numeric,
      ${x.proveedorId}::int, ${x.conceptoCodigo}, ${x.esBloqueado}, ${ORIGEN_LAZARILLO}
    )`))}`);
  if (!armado.lineas.length) return;
  const sucursalDeFila = new Map(armado.filas.map((x) => [x.rowId, branchDe.get(x.puntoDeVentaId)]));
  const principal = branchDe.get(armado.filas[0].puntoDeVentaId);
  await tx.execute(sql`
    INSERT INTO gestion_detalle_compras (
      business_id, branch_id, "rowId", "codPro", "codCpb", numero1, numero2, comprobante, fecha, codigo, nombre, medida,
      cantidad, neto, "totalIns", "ivaTot", "impNtTot", tasa, "codCga", "nomCga", "compraId", "proveedorId", origen
    ) VALUES ${sql.join(armado.lineas.map((l) => sql`(
      ${businessId}, ${(l.compraId ? sucursalDeFila.get(l.compraId) : principal)}::bigint, ${l.rowId}, ${l.codPro}, ${l.codCpb}, ${l.numero1}, ${l.numero2}, ${l.comprobante}, ${l.fecha}::date, ${l.codigo}, ${l.nombre}, ${l.medida},
      ${l.cantidad}::numeric, ${l.neto}::numeric, ${l.totalIns}::numeric, ${l.ivaTot}::numeric, ${l.impNtTot}::numeric, ${l.tasa}::numeric,
      ${l.codCga}, ${l.nomCga}, ${l.compraId}, ${l.proveedorId}::int, ${ORIGEN_LAZARILLO}
    )`))}`);
}

// ¿Ya existe ese comprobante del proveedor en el negocio? (de MaxiRest o de Lazarillo). Las NC se
// comparan sin la letra; los tickets, además, por fecha (su número no es único).
async function yaExiste(cliente, businessId, comprobante, codigo, fecha, excepto) {
  const cpb = normalizarComprobante(comprobante);
  const r = await cliente.one(sql`
    SELECT COUNT(*)::int AS n FROM gestion_compras
    WHERE business_id = ${businessId} AND codigo = ${codigo}
      AND regexp_replace(UPPER(comprobante), '^NC[ABC]?', 'NC') = ${cpb}
      AND (${!esTicket(cpb)}::boolean OR fecha::date = ${fecha}::date)
      AND NOT (${!!excepto}::boolean AND origen IS NOT DISTINCT FROM ${ORIGEN_LAZARILLO} AND comprobante = ${excepto?.comprobante ?? ''}
               AND codigo = ${excepto?.codigo ?? ''})`);
  return (r?.n ?? 0) > 0;
}

// Candado por comprobante + proveedor: doble clic o dos personas no pasan los dos el control.
const bloquearComprobante = (tx, businessId, comprobante, codigo) =>
  tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`factura:${businessId}|${codigo}|${normalizarComprobante(comprobante)}`}))`);

async function guardarCarga(tx, businessId, p, usuario, previa) {
  const a = p.armado;
  await tx.execute(sql`
    INSERT INTO gestion_facturas_movil (business_id, branch_id, comprobante, codigo, "proveedorId", fecha, total, payload, "creadoPor", "actualizadoPor", "creadoEn")
    VALUES (${businessId}, ${p.branchDe.get(a.filas[0].puntoDeVentaId)}::bigint, ${a.filas[0].comprobante}, ${p.proveedorCodigo}, ${p.f.proveedorId},
            ${p.f.fecha}::date, ${a.total}::numeric, ${JSON.stringify(p.f)}::jsonb, ${previa?.creadoPor ?? usuario}, ${usuario},
            COALESCE(${previa?.creadoEn ?? null}::timestamp, CURRENT_TIMESTAMP))`);
}

async function pagosDe(cliente, businessId, comprobante, codigo, rowIds) {
  const r = await cliente.one(sql`
    SELECT
      (SELECT COUNT(*)::int FROM gestion_pagos p WHERE p.business_id = ${businessId} AND p.comprobante = ${comprobante} AND p."codPro" = ${codigo}) AS maxirest,
      (SELECT COUNT(*)::int FROM gestion_aplicaciones_pago_interno a WHERE a.compra_business_id = ${businessId} AND a."compraRowId" = ANY(${rowIds}::text[])) AS internos,
      (SELECT COUNT(*)::int FROM gestion_aplicaciones_pago_proveedor a JOIN gestion_pagos_proveedor pp ON pp.id = a."pagoId" AND pp."anuladoEn" IS NULL
        WHERE a.business_id = ${businessId} AND a.comprobante = ${comprobante} AND a."codPro" = ${codigo}) AS lazarillo`);
  return { ...r, total: r.maxirest + r.internos + r.lazarillo };
}

async function borrarFilas(tx, businessId, comprobante, codigo) {
  await tx.execute(sql`DELETE FROM gestion_detalle_compras WHERE business_id = ${businessId} AND origen = ${ORIGEN_LAZARILLO} AND comprobante = ${comprobante} AND "codPro" = ${codigo}`);
  await tx.execute(sql`DELETE FROM gestion_compras WHERE business_id = ${businessId} AND origen = ${ORIGEN_LAZARILLO} AND comprobante = ${comprobante} AND codigo = ${codigo}`);
  await tx.execute(sql`DELETE FROM gestion_facturas_movil WHERE business_id = ${businessId} AND comprobante = ${comprobante} AND codigo = ${codigo}`);
}

// La factura a la que pertenece una fila de compras, con lo cargado si es de Lazarillo.
async function facturaDeFila(cliente, businessId, rowId) {
  const c = await cliente.one(sql`
    SELECT comprobante, codigo, branch_id, "proveedorId", origen, proveedor FROM gestion_compras WHERE business_id = ${businessId} AND "rowId" = ${rowId}`);
  if (!c || !c.comprobante || !c.codigo) return null;
  const esLz = c.origen === ORIGEN_LAZARILLO;
  const cargada = esLz
    ? await cliente.one(sql`SELECT * FROM gestion_facturas_movil WHERE business_id = ${businessId} AND comprobante = ${c.comprobante} AND codigo = ${c.codigo}`)
    : null;
  return { c, esLz, cargada };
}

// Una factura con el formato del modal de carga (ver / editar / repetir).
async function leerFactura(cliente, businessId, rowId) {
  const fa = await facturaDeFila(cliente, businessId, rowId);
  if (!fa) return null;
  const { c, esLz, cargada } = fa;
  const filas = await cliente.many(sql`
    SELECT "rowId", comprobante, "codCga", fecha, observac, importe, "importeManual", "impInt", branch_id, "proveedorId"
    FROM gestion_compras
    WHERE business_id = ${businessId} AND comprobante = ${c.comprobante} AND codigo = ${c.codigo}
      AND ${esLz ? sql`origen = ${ORIGEN_LAZARILLO}` : sql`origen IS DISTINCT FROM ${ORIGEN_LAZARILLO}`}
    ORDER BY "rowId"`);
  if (!filas.length) return null;
  const totalFilas = r2(filas.reduce((a, f) => a + Number(f.importeManual ?? f.importe ?? 0), 0));
  const proveedorId = c.proveedorId ?? filas.find((f) => f.proveedorId != null)?.proveedorId ?? null;
  if (cargada) {
    return {
      rowId, origen: 'lazarillo', editable: true, estimado: false, proveedorId, totalFilas,
      cargadaPor: cargada.creadoPor, cargadaEn: cargada.creadoEn, editadaEn: cargada.actualizadoEn, factura: cargada.payload,
    };
  }
  const lineas = await cliente.many(sql`
    SELECT codigo, nombre, medida, cantidad, "totalIns", tasa, "impNtTot", "codCga", "compraId"
    FROM gestion_detalle_compras
    WHERE business_id = ${businessId} AND comprobante = ${c.comprobante} AND "codPro" = ${c.codigo}
      ${esLz ? sql`AND origen = ${ORIGEN_LAZARILLO}` : sql``}
    ORDER BY "rowId"`);
  const n = (v) => (v == null ? null : Number(v));
  const leido = facturaDesdeFilas(
    proveedorId ?? 0,
    filas.map((f) => ({ rowId: f.rowId, comprobante: f.comprobante, codCga: f.codCga, fecha: f.fecha, observac: f.observac, importe: Number(f.importe ?? 0), impInt: Number(f.impInt ?? 0), puntoDeVentaId: idLugar(businessId, f.branch_id) })),
    lineas.map((l) => ({ ...l, cantidad: n(l.cantidad), totalIns: n(l.totalIns), tasa: n(l.tasa), impNtTot: n(l.impNtTot) })),
  );
  return { rowId, origen: esLz ? 'lazarillo' : 'maxirest', editable: esLz && proveedorId != null, estimado: leido.estimado, proveedorId, factura: leido.factura, totalFilas };
}

// ── Pagos al proveedor ("Registrar el pago ahora") ────────────────────────────
const pagoAhoraSchema = z.object({
  fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  medio: z.string().trim().min(1).max(40),
  referencia: z.string().max(200).optional().nullable(),
  importe: z.number().positive().optional(), // sin importe: salda la factura entera
});

const normalizarReferencia = (raw) => {
  const v = raw.replace(/\s+/g, '').toUpperCase();
  return /^[A-Z0-9]{1,100}$/.test(v) ? v : null;
};

// Paga la factura recién guardada, en la misma transacción: si el pago no se puede registrar, la
// factura tampoco se guarda. Lo paga el negocio activo, en la sucursal de la factura.
async function pagarFactura(tx, ctx, p, pago, usuario) {
  const { organizationId, businessId } = ctx;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`pagos-proveedor:${organizationId}:${p.proveedorCodigo}`}))`);
  const medio = await tx.one(sql`SELECT activo FROM gestion_medios_pago WHERE business_id = ${businessId} AND nombre = ${pago.medio}`);
  if (!medio?.activo) throw rechazo('No se guardó: ese medio de pago no existe o está desactivado.');
  let referencia = null;
  if (pago.referencia?.trim()) {
    referencia = normalizarReferencia(pago.referencia);
    if (!referencia) throw rechazo('No se guardó: el ID tiene que ser de letras y números.');
    const repetida = await tx.one(sql`
      SELECT 1 AS ok FROM gestion_pagos_proveedor WHERE organization_id = ${organizationId} AND referencia = ${referencia} AND "anuladoEn" IS NULL
      UNION ALL SELECT 1 FROM gestion_pagos_internos WHERE organization_id = ${organizationId} AND referencia = ${referencia} LIMIT 1`);
    if (repetida) throw rechazo('No se guardó: ese ID de transferencia ya está cargado.');
  }
  const comprobante = p.armado.filas[0].comprobante;
  // Una factura con registros en varias sucursales es una factura por sucursal en la cta cte.
  const porLugar = new Map();
  for (const x of p.armado.filas) porLugar.set(x.puntoDeVentaId, r2((porLugar.get(x.puntoDeVentaId) ?? 0) + x.importe));
  const facturas = [...porLugar.entries()].map(([id, saldo]) => ({ key: claveFactura(id, comprobante), fecha: p.f.fecha, saldo }));
  const { aplicaciones, sobrante } = imputarFacturas(facturas, pago.importe);
  const importe = r2(aplicaciones.reduce((s, a) => s + a.importe, 0) + sobrante);
  if (importe <= 0) throw rechazo('No se guardó: la factura no tiene saldo para pagar.');
  const lugarPaga = p.armado.filas[0].puntoDeVentaId;
  const creado = await tx.one(sql`
    INSERT INTO gestion_pagos_proveedor (organization_id, business_id, branch_id, "codPro", fecha, importe, medio, referencia, "creadoPor")
    VALUES (${organizationId}, ${businessId}, ${p.branchDe.get(lugarPaga)}::bigint, ${p.proveedorCodigo}, ${pago.fecha}::date, ${importe}::numeric, ${pago.medio}, ${referencia}, ${usuario})
    RETURNING id`);
  for (const a of aplicaciones) {
    const lugar = Number(a.key.slice(0, a.key.indexOf('|')));
    await tx.execute(sql`
      INSERT INTO gestion_aplicaciones_pago_proveedor ("pagoId", business_id, branch_id, comprobante, "codPro", importe)
      VALUES (${creado.id}, ${businessId}, ${p.branchDe.get(lugar)}::bigint, ${comprobante}, ${p.proveedorCodigo}, ${a.importe}::numeric)`);
  }
  await tx.execute(sql`
    INSERT INTO gestion_eventos_pago_proveedor ("pagoId", tipo, detalle, importe, usuario)
    VALUES (${creado.id}, 'creado', ${`${aplicaciones.length} factura${aplicaciones.length === 1 ? '' : 's'}`}, ${importe}::numeric, ${usuario})`);
  return { id: creado.id, numero: numeroPago(creado.id), aplicado: r2(importe - sobrante), aCuenta: sobrante };
}

// Alta dentro de una transacción: la usan la carga de factura y Gastos Varios.
async function altaEnTx(tx, ctx, p, pagoAhora, usuario, descripcion) {
  const { organizationId, businessId } = ctx;
  const { armado } = p;
  const comprobante = armado.filas[0].comprobante;
  await bloquearComprobante(tx, businessId, comprobante, p.proveedorCodigo);
  if (await yaExiste(tx, businessId, comprobante, p.proveedorCodigo, p.f.fecha)) throw rechazo('Esta factura ya está cargada', 409);
  await insertarArmado(tx, businessId, p);
  await guardarCarga(tx, businessId, p, usuario);
  const pago = pagoAhora ? await pagarFactura(tx, ctx, p, pagoAhora, usuario) : null;
  const lugar = p.lugares.find((l) => l.id === armado.filas[0].puntoDeVentaId)?.nombre ?? null;
  await registrarActividad(tx, { organizationId, businessId, tipo: 'factura', accion: 'creada', descripcion: descripcion(lugar), refId: armado.filas[0].rowId, usuario });
  return pago;
}

// POST factura
async function crearFactura({ organizationId, businessId, usuario, body }) {
  const pagoAhora = body?.pago != null ? pagoAhoraSchema.safeParse(body.pago) : null;
  if (pagoAhora && !pagoAhora.success) throw rechazo('Datos del pago inválidos');
  const ctx = { organizationId, businessId };
  return db.transaction(async (tx) => {
    const p = await prepararFactura(tx, ctx, body);
    const pago = await altaEnTx(tx, ctx, p, pagoAhora?.success ? pagoAhora.data : null, usuario,
      (lugar) => descripcionFactura({ ...p, total: p.armado.total, lugar }));
    const { armado } = p;
    return { ok: true, comprobante: armado.filas[0].comprobante, total: armado.total, filas: armado.filas.length, lineas: armado.lineas.length, rowId: armado.filas[0].rowId, pago };
  });
}

const obtenerFactura = async ({ businessId, rowId }) => (await leerFactura(db, businessId, rowId)) ?? { noEsFactura: true };

// PUT: se rearman sus filas (nunca se duplica); las correcciones a mano siguen en las filas que quedan.
async function editarFactura({ organizationId, businessId, usuario, rowId, body }) {
  const ctx = { organizationId, businessId };
  return db.transaction(async (tx) => {
    const fa = await facturaDeFila(tx, businessId, rowId);
    if (!fa) throw rechazo('No existe la factura', 404);
    if (!fa.esLz) throw rechazo('Es de MaxiRest: se modifica en MaxiRest', 403);
    const p = await prepararFactura(tx, ctx, body);
    const comprobante = p.armado.filas[0].comprobante;
    const antes = { comprobante: fa.c.comprobante, codigo: fa.c.codigo };
    const filasAntes = await tx.many(sql`
      SELECT "rowId" FROM gestion_compras WHERE business_id = ${businessId} AND origen = ${ORIGEN_LAZARILLO} AND comprobante = ${antes.comprobante} AND codigo = ${antes.codigo}`);
    const nuevos = new Set(p.armado.filas.map((x) => x.rowId));
    const sacadas = filasAntes.map((x) => x.rowId).filter((id) => !nuevos.has(id));
    const cambiaClave = comprobante !== antes.comprobante || p.proveedorCodigo !== antes.codigo;
    const pagos = await pagosDe(tx, businessId, antes.comprobante, antes.codigo, sacadas);
    if ((cambiaClave && pagos.total) || pagos.internos) {
      throw rechazo('La factura tiene pagos: no se puede cambiar el número, el proveedor ni la sucursal / concepto de lo pagado', 409);
    }
    await bloquearComprobante(tx, businessId, comprobante, p.proveedorCodigo);
    if (await yaExiste(tx, businessId, comprobante, p.proveedorCodigo, p.f.fecha, antes)) throw rechazo('Ya hay otra factura con ese proveedor y número', 409);
    const correcciones = await tx.many(sql`
      SELECT "rowId", "importeManual", "fechaManual", "observacManual", "conceptoCodigoManual" FROM gestion_compras
      WHERE business_id = ${businessId} AND origen = ${ORIGEN_LAZARILLO} AND comprobante = ${antes.comprobante} AND codigo = ${antes.codigo}
        AND ("importeManual" IS NOT NULL OR "fechaManual" IS NOT NULL OR "observacManual" IS NOT NULL OR "conceptoCodigoManual" IS NOT NULL)`);
    await borrarFilas(tx, businessId, antes.comprobante, antes.codigo);
    await insertarArmado(tx, businessId, p);
    let perdidas = 0;
    for (const c of correcciones) {
      if (!nuevos.has(c.rowId)) { perdidas += 1; continue; }
      await tx.execute(sql`
        UPDATE gestion_compras SET "importeManual" = ${c.importeManual}::numeric, "fechaManual" = ${c.fechaManual}::timestamp, "observacManual" = ${c.observacManual}, "conceptoCodigoManual" = ${c.conceptoCodigoManual}
        WHERE business_id = ${businessId} AND "rowId" = ${c.rowId}`);
    }
    await guardarCarga(tx, businessId, p, usuario, fa.cargada);
    const lugar = p.lugares.find((l) => l.id === p.armado.filas[0].puntoDeVentaId)?.nombre ?? null;
    await registrarActividad(tx, {
      organizationId, businessId, tipo: 'factura', accion: 'editada', usuario, refId: p.armado.filas[0].rowId,
      descripcion: descripcionFactura({ ...p, total: p.armado.total, lugar }),
    });
    return { ok: true, comprobante, total: p.armado.total, rowId: p.armado.filas[0].rowId, correccionesPerdidas: perdidas };
  });
}

// DELETE: con pagos avisa primero; si se confirma, los del Panel vuelven a quedar a cuenta (los
// del informe 80 vienen de MaxiRest). Lo cargado queda en la actividad.
async function borrarFactura({ organizationId, businessId, usuario, rowId, conPagos }) {
  return db.transaction(async (tx) => {
    const fa = await facturaDeFila(tx, businessId, rowId);
    if (!fa) throw rechazo('No existe la factura', 404);
    if (!fa.esLz) throw rechazo('Es de MaxiRest: se borra en MaxiRest', 403);
    const filas = await tx.many(sql`
      SELECT "rowId", importe FROM gestion_compras WHERE business_id = ${businessId} AND origen = ${ORIGEN_LAZARILLO} AND comprobante = ${fa.c.comprobante} AND codigo = ${fa.c.codigo}`);
    const ids = filas.map((x) => x.rowId);
    const pagos = await pagosDe(tx, businessId, fa.c.comprobante, fa.c.codigo, ids);
    if (pagos.total && !conPagos) throw rechazo('La factura tiene pagos', 409, { tienePagos: pagos });
    const total = filas.reduce((a, f) => a + Number(f.importe ?? 0), 0);
    if (pagos.internos) await tx.execute(sql`DELETE FROM gestion_aplicaciones_pago_interno WHERE compra_business_id = ${businessId} AND "compraRowId" = ANY(${ids}::text[])`);
    if (pagos.lazarillo) await tx.execute(sql`DELETE FROM gestion_aplicaciones_pago_proveedor WHERE business_id = ${businessId} AND comprobante = ${fa.c.comprobante} AND "codPro" = ${fa.c.codigo}`);
    await borrarFilas(tx, businessId, fa.c.comprobante, fa.c.codigo);
    await registrarActividad(tx, {
      organizationId, businessId, tipo: 'factura', accion: 'eliminada', usuario,
      descripcion: `${fa.c.proveedor?.trim() || fa.c.codigo}\n${[fa.c.comprobante, pesos(total)].join(' · ')}`,
      datos: fa.cargada ? { payload: fa.cargada.payload, pagos } : null,
    });
    return { ok: true, filas: filas.length };
  });
}

// Detección de factura ya cargada en el modal.
async function facturaExiste({ organizationId, businessId, sp }) {
  const proveedorId = Number(sp.get('proveedorId'));
  const tipo = sp.get('tipo');
  const prefijo = sp.get('prefijo') ?? '';
  const numero = sp.get('numero') ?? '';
  const fecha = /^\d{4}-\d{2}-\d{2}$/.test(sp.get('fecha') ?? '') ? sp.get('fecha') : null;
  if (!Number.isInteger(proveedorId) || !(tipo in TIPOS_COMPROBANTE) || !/^\d{1,4}$/.test(prefijo) || !/^\d{1,8}$/.test(numero)) return { existe: false };
  const prov = await db.one(sql`SELECT codigo FROM gestion_proveedores WHERE organization_id = ${organizationId} AND id = ${proveedorId}`);
  if (!prov) return { existe: false };
  const { comprobante } = comprobanteDe(tipo, prefijo, numero);
  const f = await db.one(sql`
    SELECT MIN(fecha) AS fecha, SUM(COALESCE("importeManual", importe))::float8 AS total, MAX(origen) AS origen
    FROM gestion_compras
    WHERE business_id = ${businessId} AND codigo = ${prov.codigo}
      AND regexp_replace(UPPER(comprobante), '^NC[ABC]?', 'NC') = ${normalizarComprobante(comprobante)}
      AND (${!esTicket(comprobante)}::boolean OR ${fecha}::date IS NULL OR fecha::date = ${fecha}::date)
    HAVING COUNT(*) > 0`);
  if (!f) return { existe: false };
  return { existe: true, origen: f.origen === 'lazarillo' ? 'lazarillo' : 'maxirest', fecha: iso(f.fecha), total: f.total };
}

// La última factura del proveedor en el negocio: "Precargar esa estructura" (Repetir).
async function ultimaFactura({ businessId, sp }) {
  const proveedorId = Number(sp.get('proveedorId'));
  if (!Number.isInteger(proveedorId)) return { ultima: null };
  const orden = await db.many(sql`
    SELECT MIN("rowId") AS "rowId" FROM gestion_compras
    WHERE business_id = ${businessId} AND "proveedorId" = ${proveedorId}
      AND comprobante IS NOT NULL AND UPPER(LEFT(comprobante, 1)) NOT IN ('N', 'E', 'G')
    GROUP BY comprobante
    -- Primero la última FACTURA de los últimos 6 meses: un ticket suelto no es la estructura habitual.
    ORDER BY (UPPER(LEFT(comprobante, 1)) = 'Z' OR MAX(fecha) < CURRENT_DATE - 180), MAX(fecha) DESC NULLS LAST
    LIMIT 3`);
  for (const o of orden) {
    const leida = await leerFactura(db, businessId, o.rowId);
    if (leida && leida.factura.registros.length) return { ultima: leida };
  }
  return { ultima: null };
}

// Maestros del modal: proveedores y conceptos de la organización, lugares del negocio, e insumos.
// Con MaxiRest, el maestro m0 del kit más lo comprado; sin MaxiRest, lo que ya se compró y el
// catálogo de insumos del negocio en Lazarillo.
async function insumosMaxirest(organizationId) {
  if (!renderConfigurado()) return [];
  try {
    const origen = await db.one(sql`
      SELECT o.esquema FROM gestion_render_origenes o JOIN app_businesses b ON b.id = o.business_id
      WHERE o.activo AND b.organization_id = ${organizationId} LIMIT 1`);
    return origen ? await leerInsumos(origen.esquema) : [];
  } catch (err) {
    console.error('[gestion/facturas/maestros] kit', err);
    return [];
  }
}

async function obtenerMaestrosFactura({ organizationId, businessId }) {
  const [proveedores, conceptos, comprados, lugares, deMaxirest] = await Promise.all([
    db.many(sql`SELECT id, codigo, nombre, razon, cuit FROM gestion_proveedores WHERE organization_id = ${organizationId} ORDER BY nombre`),
    db.many(sql`
      SELECT TRIM(cc.codigo) AS codigo, TRIM(cc.nombre) AS nombre, COALESCE(TRIM(rc.nombre), 'Sin Rubro') AS rubro
      FROM gestion_conceptos_caja cc
      LEFT JOIN gestion_rubros_concepto_caja rc ON rc.organization_id = ${organizationId} AND rc.codigo = cc."codRga"
      WHERE cc.organization_id = ${organizationId} ORDER BY cc.nombre`),
    db.many(sql`
      SELECT DISTINCT ON (codigo) codigo, TRIM(nombre) AS nombre, TRIM(medida) AS medida, "codCga", neto::float8 AS unit, tasa::float8 AS alic
      FROM gestion_detalle_compras
      WHERE business_id IN (SELECT id FROM app_businesses WHERE organization_id = ${organizationId})
        AND NULLIF(TRIM(medida), '') IS NOT NULL AND codigo IS NOT NULL AND nombre IS NOT NULL
      ORDER BY codigo, fecha DESC NULLS LAST`),
    obtenerLugares(db, businessId),
    insumosMaxirest(organizationId),
  ]);
  return { proveedores, conceptos, insumos: unirInsumos(deMaxirest, comprados), lugares };
}

// Alta de un proveedor propio (negocios sin MaxiRest, o uno nuevo que todavía no está en el maestro).
// Código "L" + número: no choca con los de MaxiRest, que son numéricos.
const proveedorSchema = z.object({
  nombre: z.string().trim().min(1, 'Poné un nombre').max(120),
  razon: z.string().trim().max(120).optional().nullable(),
  cuit: z.string().trim().max(20).optional().nullable(),
});

async function crearProveedor({ organizationId, body }) {
  const parsed = proveedorSchema.safeParse(body);
  if (!parsed.success) throw rechazo(parsed.error.issues[0]?.message ?? 'Datos inválidos', 422);
  const { nombre, razon, cuit } = parsed.data;
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`proveedores:${organizationId}`}))`);
    const igual = await tx.one(sql`SELECT id FROM gestion_proveedores WHERE organization_id = ${organizationId} AND LOWER(TRIM(nombre)) = LOWER(${nombre})`);
    if (igual) throw rechazo(`Ya existe un proveedor "${nombre}".`, 409);
    const mayor = await tx.one(sql`SELECT MAX(SUBSTRING(codigo FROM 2)::int) AS n FROM gestion_proveedores WHERE organization_id = ${organizationId} AND codigo ~ '^L[0-9]+$'`);
    const codigo = `L${(mayor?.n ?? 0) + 1}`;
    return tx.one(sql`
      INSERT INTO gestion_proveedores (organization_id, codigo, nombre, razon, cuit)
      VALUES (${organizationId}, ${codigo}, ${nombre}, ${razon || nombre}, ${cuit || null})
      RETURNING id, codigo, nombre, razon, cuit`);
  });
}

// ── Gastos varios ───────────────────────────────────────────────────────────────
// Un Ticket interno del proveedor "Gastos Varios" (9999-NNNNNNNN), sin IVA. Con pago, se registra
// en la misma transacción; sin pago queda impago.
const gastoSchema = z.object({
  lugarId: z.number().int(),
  conceptoCodigo: z.string().trim().min(1).max(20),
  detalle: z.string().trim().max(200).optional().nullable(),
  importe: z.number().positive().max(1e12),
  fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  pago: pagoAhoraSchema.omit({ importe: true }).optional().nullable(),
  forzar: z.boolean().optional(), // ya se avisó que hay uno parecido
});

async function crearGastoVario({ organizationId, businessId, usuario, body }) {
  const parsed = gastoSchema.safeParse(body);
  if (!parsed.success) throw rechazo('Datos inválidos', 400, { detalle: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
  const g = parsed.data;
  const importe = r2(g.importe);
  const ctx = { organizationId, businessId };
  const lugares = await obtenerLugares(db, businessId);
  const lugar = lugares.find((l) => l.id === g.lugarId);
  if (!lugar) throw rechazo('Sucursal inexistente');

  // Nunca duplicar: el mismo gasto (sucursal + concepto + importe ±1 en el mismo mes) → se avisa.
  if (!g.forzar) {
    const parecido = await db.one(sql`
      SELECT TO_CHAR(COALESCE(c."fechaManual", c.fecha), 'YYYY-MM-DD') AS fecha, COALESCE(c."importeManual", c.importe)::float8 AS importe,
             c.origen, COALESCE(c."observacManual", c.observac) AS observac
      FROM gestion_compras c
      WHERE c.business_id = ${businessId} AND c.branch_id IS NOT DISTINCT FROM ${lugar.branchId}::bigint
        AND COALESCE(c."conceptoCodigoManual", c."conceptoCodigo") = ${g.conceptoCodigo}
        AND ABS(COALESCE(c."importeManual", c.importe) - ${importe}::numeric) <= 1
        AND DATE_TRUNC('month', COALESCE(c."fechaManual", c.fecha)) = DATE_TRUNC('month', ${g.fecha}::date)
        AND (c.comprobante IS NULL OR UPPER(LEFT(c.comprobante, 1)) IN ('E', 'G') OR c.codigo = ${GV_CODIGO})
      LIMIT 1`);
    if (parecido) throw rechazo('Ya hay un gasto parecido', 409, { parecido });
  }

  return db.transaction(async (tx) => {
    // El proveedor "Gastos Varios" se crea la primera vez.
    await tx.execute(sql`
      INSERT INTO gestion_proveedores (organization_id, codigo, nombre, razon) VALUES (${organizationId}, ${GV_CODIGO}, ${GV_NOMBRE}, ${GV_NOMBRE})
      ON CONFLICT (organization_id, codigo) DO NOTHING`);
    const gv = await tx.one(sql`SELECT id FROM gestion_proveedores WHERE organization_id = ${organizationId} AND codigo = ${GV_CODIGO}`);
    // Numeración interna correlativa por negocio.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`gastos-varios:${businessId}`}))`);
    const mayor = await tx.one(sql`
      SELECT MAX(comprobante) AS m FROM gestion_compras
      WHERE business_id = ${businessId} AND codigo = ${GV_CODIGO} AND comprobante ~ ${`^Z${GV_PREFIJO}[0-9]{8}$`}`);
    const numero = siguienteNumeroGV(mayor?.m);
    const concepto = await tx.one(sql`SELECT nombre FROM gestion_conceptos_caja WHERE organization_id = ${organizationId} AND codigo = ${g.conceptoCodigo}`);
    if (!concepto) throw rechazo('Ese concepto no existe.');
    const p = await prepararFactura(tx, ctx, {
      proveedorId: gv.id, tipo: 'Ticket', prefijo: GV_PREFIJO, numero, fecha: g.fecha, observacion: g.detalle?.trim() || null,
      registros: [{ tipo: 'concepto', conceptoCodigo: g.conceptoCodigo, nombre: concepto.nombre.trim(), neto: importe, alicuota: 0, impInt: 0, puntoDeVentaId: g.lugarId, reparto: null }],
      percepciones: [], impIntGeneral: 0,
    });
    const total = p.armado.total;
    const pago = await altaEnTx(tx, ctx, p, g.pago ?? null, usuario, (nombre) =>
      `${GV_NOMBRE}\n${[concepto.nombre.trim(), g.detalle?.trim(), nombre, pesos(total)].filter(Boolean).join(' · ')}`);
    return { ok: true, comprobante: p.armado.filas[0].comprobante, numero: `${GV_PREFIJO}-${numero}`, total, rowId: p.armado.filas[0].rowId, pago };
  });
}

// ── Ventas manuales ─────────────────────────────────────────────────────────────
const MAN = `${PREFIJO_MANUAL}%`;
const ventasAltaSchema = z.object({ items: z.array(itemSchema).min(1).max(400), forzar: z.boolean().optional() });
const exigirSucursal = (sucursal) => { if (sucursal === undefined) throw rechazo('Elegí una sucursal'); };

async function obtenerVentasManuales({ businessId, sucursal }) {
  exigirSucursal(sucursal);
  const lugar = sql`business_id = ${businessId} AND branch_id IS NOT DISTINCT FROM ${sucursal}::bigint`;
  const [items, solapadas, tipos, cobros] = await Promise.all([
    db.many(sql`
      SELECT "rowId", TO_CHAR(fecha, 'YYYY-MM-DD') AS fecha, tipo, cobro, importe::float8 AS importe, comprobant AS detalle, "cliRazon" AS cliente
      FROM gestion_ventas WHERE ${lugar} AND "rowId" LIKE ${MAN}
      ORDER BY fecha DESC, tipo NULLS LAST LIMIT 400`),
    db.many(sql`
      SELECT TO_CHAR(m.dia, 'YYYY-MM-DD') AS fecha, m.total::float8 AS manual, r.total::float8 AS real
      FROM (SELECT fecha::date AS dia, SUM(importe) AS total FROM gestion_ventas WHERE ${lugar} AND "rowId" LIKE ${MAN} GROUP BY 1) m
      JOIN (SELECT fecha::date AS dia, SUM(importe) AS total FROM gestion_ventas WHERE ${lugar} AND "rowId" NOT LIKE ${MAN}
              AND fecha >= (SELECT MIN(fecha) FROM gestion_ventas WHERE ${lugar} AND "rowId" LIKE ${MAN}) GROUP BY 1) r ON r.dia = m.dia
      ORDER BY 1`),
    db.many(sql`
      SELECT DISTINCT TRIM(tipo) AS v FROM gestion_ventas WHERE ${lugar} AND fecha >= NOW() - INTERVAL '400 days'
        AND tipo IS NOT NULL AND TRIM(tipo) <> '' ORDER BY 1 LIMIT 20`),
    db.many(sql`
      SELECT DISTINCT TRIM(cobro) AS v FROM gestion_ventas WHERE ${lugar} AND fecha >= NOW() - INTERVAL '400 days'
        AND cobro IS NOT NULL AND TRIM(cobro) <> '' AND "codCobro" IS DISTINCT FROM ${COD_COBRO_MANUAL}
        AND cobro !~ '^(FC|NC|ND)[ABC] ' ORDER BY 1 LIMIT 30`),
  ]);
  return { items, solapadas, tipos: tipos.map((t) => t.v), cobros: cobros.map((c) => c.v) };
}

// Nunca duplica: si un ingreso igual (día, tipo, cobro e importe) ya está cargado, avisa y no guarda nada.
async function crearVentasManuales({ businessId, sucursal, body }) {
  exigirSucursal(sucursal);
  const parsed = ventasAltaSchema.safeParse(body);
  if (!parsed.success) throw rechazo('Datos inválidos', 400, { detalle: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
  const { items, forzar } = parsed.data;
  const vistos = new Set();
  for (const it of items) {
    const k = claveIngreso(it);
    if (vistos.has(k)) throw rechazo(`El ingreso del ${it.fecha} por ${it.importe} está dos veces.`);
    vistos.add(k);
  }
  if (!forzar) {
    const fechas = items.map((i) => i.fecha).sort();
    const ya = await db.many(sql`
      SELECT TO_CHAR(fecha, 'YYYY-MM-DD') AS fecha, tipo, cobro, importe::float8 AS importe FROM gestion_ventas
      WHERE business_id = ${businessId} AND branch_id IS NOT DISTINCT FROM ${sucursal}::bigint AND "rowId" LIKE ${MAN}
        AND fecha >= ${fechas[0]}::date AND fecha < ${fechas[fechas.length - 1]}::date + 1`);
    const existentes = new Set(ya.map(claveIngreso));
    const repetidos = items.filter((i) => existentes.has(claveIngreso(i)));
    if (repetidos.length) throw rechazo('Ya cargados', 409, { repetidos });
  }
  await db.execute(sql`
    INSERT INTO gestion_ventas (business_id, branch_id, "rowId", comprobant, tipo, cobro, "codCobro", importe, "importeTrabajado", total, descuento, "cliRazon", fecha)
    VALUES ${sql.join(items.map((it) => sql`(
      ${businessId}, ${sucursal}::bigint, ${PREFIJO_MANUAL + randomUUID().replace(/-/g, '').slice(0, 20)}, ${it.detalle}, ${it.tipo}, ${it.cobro}, ${COD_COBRO_MANUAL},
      ${it.importe}::numeric, ${it.importe}::numeric, ${it.importe}::numeric, 0, ${it.cliente}, ${it.fecha}::timestamp)`))}`);
  return { ok: true, cargados: items.length, total: items.reduce((s, i) => s + i.importe, 0) };
}

// Solo borra cargas manuales del negocio.
async function borrarVentasManuales({ businessId, ids: idsCrudos }) {
  const ids = String(idsCrudos ?? '').split(',').map((s) => s.trim()).filter((s) => s.startsWith(PREFIJO_MANUAL));
  if (!ids.length) throw rechazo('Nada para borrar');
  const n = await db.execute(sql`DELETE FROM gestion_ventas WHERE business_id = ${businessId} AND "rowId" = ANY(${ids}::text[]) AND "rowId" LIKE ${MAN}`);
  return { ok: true, borrados: n };
}

// ── Conceptos de caja (maestro de la organización) ─────────────────────────────
async function obtenerConceptos({ organizationId }) {
  const [filas, rubros, conRegistros] = await Promise.all([
    db.many(sql`
      SELECT c.codigo, TRIM(c.nombre) AS nombre, c.tipo, c."codRga", c."codImp", TRIM(r.nombre) AS rubro, c."editadoEnLazarillo",
             TRIM(c."nombreMaxirest") AS "nombreMx", c."tipoMaxirest" AS "tipoMx", c."codRgaMaxirest" AS "codRgaMx", TRIM(rm.nombre) AS "rubroMx"
      FROM gestion_conceptos_caja c
      LEFT JOIN gestion_rubros_concepto_caja r  ON r.organization_id = ${organizationId} AND r.codigo = c."codRga"
      LEFT JOIN gestion_rubros_concepto_caja rm ON rm.organization_id = ${organizationId} AND rm.codigo = c."codRgaMaxirest"
      WHERE c.organization_id = ${organizationId}`),
    db.many(sql`SELECT codigo, nombre FROM gestion_rubros_concepto_caja WHERE organization_id = ${organizationId}`),
    // Conceptos con al menos un registro: los demás se marcan "sin uso".
    db.many(sql`
      SELECT DISTINCT c FROM (
        SELECT "codCga" AS c FROM gestion_compras WHERE "codCga" IS NOT NULL AND business_id IN (SELECT id FROM app_businesses WHERE organization_id = ${organizationId})
        UNION SELECT "conceptoCodigoManual" FROM gestion_compras WHERE "conceptoCodigoManual" IS NOT NULL AND business_id IN (SELECT id FROM app_businesses WHERE organization_id = ${organizationId})
      ) t`),
  ]);
  const conceptos = filas
    .map((c) => ({
      codigo: Number(c.codigo), nombre: c.nombre, tipo: c.tipo, codRubro: c.codRga != null ? Number(c.codRga) : null, rubro: c.rubro ?? null, imputacion: c.codImp,
      ...(c.editadoEnLazarillo ? { editado: true, original: { nombre: c.nombreMx ?? c.nombre, tipo: c.tipoMx, codRubro: c.codRgaMx != null ? Number(c.codRgaMx) : null, rubro: c.rubroMx ?? null } } : {}),
    }))
    .filter((c) => Number.isFinite(c.codigo))
    .sort((a, b) => a.codigo - b.codigo);
  return {
    fuente: 'panel', conceptos,
    conRegistros: conRegistros.map((f) => String(f.c).trim()),
    rubros: rubros.sort((a, b) => Number(a.codigo) - Number(b.codigo)),
  };
}

const exigirRubro = async (organizationId, codigo) => {
  const r = await db.one(sql`SELECT 1 AS ok FROM gestion_rubros_concepto_caja WHERE organization_id = ${organizationId} AND codigo = ${codigo}`);
  if (!r) throw rechazo('El rubro no existe', 422);
};

// Alta de un concepto propio (código desde 1000: MaxiRest llega al 999).
async function crearConcepto({ organizationId, body }) {
  const parsed = conceptoPropioSchema.safeParse(body);
  if (!parsed.success) throw rechazo(parsed.error.issues[0]?.message ?? 'Datos inválidos', 422);
  const d = parsed.data;
  await exigirRubro(organizationId, d.codRubro);
  const existentes = await db.many(sql`SELECT codigo FROM gestion_conceptos_caja WHERE organization_id = ${organizationId}`);
  const codigo = d.codigo ?? proximoCodigoLazarillo(existentes.map((c) => c.codigo));
  if (existentes.some((c) => Number(c.codigo) === codigo)) throw rechazo(`El código ${codigo} ya existe`, 409);
  await db.execute(sql`
    INSERT INTO gestion_conceptos_caja (organization_id, codigo, nombre, tipo, "codRga", "codImp")
    VALUES (${organizationId}, ${String(codigo)}, ${d.nombre}, ${d.tipo}, ${d.codRubro}, ${d.imputacion || null})`);
  return { codigo, reglasCopiadas: 0 };
}

const edicionMaxirestSchema = z.union([
  z.object({ restaurar: z.literal(true) }),
  conceptoPropioSchema.pick({ nombre: true, tipo: true, codRubro: true }),
]);

// Propios: se modifican. De MaxiRest: nombre, tipo y rubro; el original queda en *Maxirest y la
// sincronización no pisa lo editado. { restaurar: true } vuelve al de MaxiRest.
async function editarConcepto({ organizationId, codigo: crudo, body }) {
  const n = Number(crudo);
  if (!Number.isInteger(n) || n <= 0) throw rechazo('Código inválido');
  const codigo = String(n);
  if (esPropio(n)) {
    const parsed = conceptoPropioSchema.omit({ codigo: true }).safeParse(body);
    if (!parsed.success) throw rechazo(parsed.error.issues[0]?.message ?? 'Datos inválidos', 422);
    const d = parsed.data;
    await exigirRubro(organizationId, d.codRubro);
    const r = await db.execute(sql`
      UPDATE gestion_conceptos_caja SET nombre = ${d.nombre}, tipo = ${d.tipo}, "codRga" = ${d.codRubro}
        ${d.imputacion !== undefined ? sql`, "codImp" = ${d.imputacion || null}` : sql``}
      WHERE organization_id = ${organizationId} AND codigo = ${codigo}`);
    if (!r) throw rechazo('No existe', 404);
    return { ok: true };
  }
  const parsed = edicionMaxirestSchema.safeParse(body);
  if (!parsed.success) throw rechazo(parsed.error.issues[0]?.message ?? 'Datos inválidos', 422);
  const d = parsed.data;
  if ('restaurar' in d) {
    const r = await db.execute(sql`
      UPDATE gestion_conceptos_caja SET nombre = COALESCE("nombreMaxirest", nombre), tipo = COALESCE("tipoMaxirest", tipo),
        "codRga" = COALESCE("codRgaMaxirest", "codRga"), "editadoEnLazarillo" = false
      WHERE organization_id = ${organizationId} AND codigo = ${codigo}`);
    if (!r) throw rechazo('No existe', 404);
    return { ok: true };
  }
  await exigirRubro(organizationId, d.codRubro);
  const r = await db.execute(sql`
    UPDATE gestion_conceptos_caja SET
      "nombreMaxirest" = COALESCE("nombreMaxirest", nombre), "tipoMaxirest" = COALESCE("tipoMaxirest", tipo),
      "codRgaMaxirest" = COALESCE("codRgaMaxirest", "codRga"),
      nombre = ${d.nombre}, tipo = ${d.tipo}, "codRga" = ${d.codRubro}, "editadoEnLazarillo" = true
    WHERE organization_id = ${organizationId} AND codigo = ${codigo}`);
  if (!r) throw rechazo('Ese concepto todavía no está en el Panel.', 404);
  return { ok: true };
}

async function borrarConcepto({ organizationId, codigo: crudo }) {
  const n = Number(crudo);
  if (!Number.isInteger(n) || !esPropio(n)) throw rechazo('Solo se dan de baja los conceptos de Lazarillo (desde 1000)', 403);
  const codigo = String(n);
  const negocios = sql`(SELECT id FROM app_businesses WHERE organization_id = ${organizationId})`;
  const u = await db.one(sql`
    SELECT (SELECT COUNT(*)::int FROM gestion_compras WHERE business_id IN ${negocios} AND ("codCga" = ${codigo} OR "conceptoCodigo" = ${codigo} OR "conceptoCodigoManual" = ${codigo}))
         + (SELECT COUNT(*)::int FROM gestion_detalle_compras WHERE business_id IN ${negocios} AND "codCga" = ${codigo}) AS n`);
  if (u.n > 0) throw rechazo(`Tiene ${u.n} registro${u.n === 1 ? '' : 's'}: no se puede dar de baja`, 409);
  await db.execute(sql`DELETE FROM gestion_conceptos_caja WHERE organization_id = ${organizationId} AND codigo = ${codigo}`);
  return { ok: true };
}

// ── Medios de pago (del negocio) ───────────────────────────────────────────────
async function obtenerMedios({ businessId }) {
  const [medios, usos] = await Promise.all([
    db.many(sql`SELECT id, nombre, tipo, "pideId", activo, orden FROM gestion_medios_pago WHERE business_id = ${businessId} ORDER BY orden, nombre`),
    db.many(sql`
      SELECT medio, SUM(n)::int AS n FROM (
        SELECT medio, COUNT(*) AS n FROM gestion_pagos_proveedor WHERE business_id = ${businessId} GROUP BY 1
        UNION ALL SELECT medio, COUNT(*) FROM gestion_pagos_internos WHERE origen_business_id = ${businessId} GROUP BY 1
      ) t GROUP BY 1`),
  ]);
  const cuenta = new Map(usos.map((u) => [u.medio, u.n]));
  return medios.map((m) => ({ ...m, usos: cuenta.get(m.nombre) ?? 0 }));
}

async function crearMedio({ businessId, body }) {
  const parsed = medioSchema.safeParse(body);
  if (!parsed.success) throw rechazo(parsed.error.issues[0]?.message ?? 'Datos inválidos');
  const b = parsed.data;
  const todos = await db.many(sql`SELECT nombre, orden FROM gestion_medios_pago WHERE business_id = ${businessId}`);
  if (todos.some((m) => mismoNombre(m.nombre, b.nombre))) throw rechazo(`Ya existe un medio "${b.nombre}".`, 409);
  const orden = todos.reduce((a, m) => Math.max(a, m.orden), 0) + 1;
  const m = await db.one(sql`
    INSERT INTO gestion_medios_pago (business_id, nombre, tipo, "pideId", activo, orden)
    VALUES (${businessId}, ${b.nombre}, ${b.tipo}, ${b.pideId}, ${b.activo ?? true}, ${orden}) RETURNING id`);
  return { id: m.id };
}

// Si cambia el nombre, los pagos que lo usaban pasan al nombre nuevo en la misma transacción.
async function editarMedio({ businessId, id, body }) {
  const parsed = medioSchema.safeParse(body);
  if (!parsed.success) throw rechazo(parsed.error.issues[0]?.message ?? 'Datos inválidos');
  const b = parsed.data;
  return db.transaction(async (tx) => {
    const actual = await tx.one(sql`SELECT * FROM gestion_medios_pago WHERE business_id = ${businessId} AND id = ${id}`);
    if (!actual) throw rechazo('Ese medio ya no existe.', 404);
    const otros = await tx.many(sql`SELECT nombre FROM gestion_medios_pago WHERE business_id = ${businessId} AND id <> ${id}`);
    if (otros.some((m) => mismoNombre(m.nombre, b.nombre))) throw rechazo(`Ya existe un medio "${b.nombre}".`, 409);
    await tx.execute(sql`
      UPDATE gestion_medios_pago SET nombre = ${b.nombre}, tipo = ${b.tipo}, "pideId" = ${b.pideId}, activo = ${b.activo ?? actual.activo}
      WHERE id = ${id}`);
    if (b.nombre !== actual.nombre) {
      await tx.execute(sql`UPDATE gestion_pagos_proveedor SET medio = ${b.nombre} WHERE business_id = ${businessId} AND medio = ${actual.nombre}`);
      await tx.execute(sql`UPDATE gestion_pagos_internos SET medio = ${b.nombre} WHERE origen_business_id = ${businessId} AND medio = ${actual.nombre}`);
    }
    return { ok: true };
  });
}

// Solo si ningún pago lo usa; si tiene pagos, se desactiva.
async function borrarMedio({ businessId, id }) {
  const actual = await db.one(sql`SELECT nombre FROM gestion_medios_pago WHERE business_id = ${businessId} AND id = ${id}`);
  if (!actual) throw rechazo('Ese medio ya no existe.', 404);
  const u = await db.one(sql`
    SELECT (SELECT COUNT(*)::int FROM gestion_pagos_proveedor WHERE business_id = ${businessId} AND medio = ${actual.nombre})
         + (SELECT COUNT(*)::int FROM gestion_pagos_internos WHERE origen_business_id = ${businessId} AND medio = ${actual.nombre}) AS n`);
  if (u.n > 0) throw rechazo(`Lo usan ${u.n} pago${u.n === 1 ? '' : 's'}: desactivalo en vez de borrarlo.`, 409);
  await db.execute(sql`DELETE FROM gestion_medios_pago WHERE business_id = ${businessId} AND id = ${id}`);
  return { ok: true };
}

module.exports = {
  idLugar, obtenerLugares, combinarPagos,
  crearFactura, obtenerFactura, editarFactura, borrarFactura, facturaExiste, ultimaFactura, obtenerMaestrosFactura, crearProveedor,
  crearGastoVario, obtenerVentasManuales, crearVentasManuales, borrarVentasManuales,
  obtenerConceptos, crearConcepto, editarConcepto, borrarConcepto,
  obtenerMedios, crearMedio, editarMedio, borrarMedio,
};
