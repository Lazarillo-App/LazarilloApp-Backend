// services/gestion/apertura/motor.js
// Motor de apertura de gastos. Port de lazarillo_gestion/lib/apertura/{motor,reevaluacion,reimportacion}.ts.
//
// Una regla toma compras de un lugar de origen (negocio + sucursal) y las reparte entre destinos, que
// pueden ser sucursales de otro negocio de la misma organización. Una compra solo vive en su negocio,
// así que todo se acota al negocio de origen de la regla: la plata de un negocio nunca se toca desde
// la regla de otro.
//
// Invariantes que vienen de gestion y no se negocian: la suma de lo repartido es exacta (calculo.js);
// todo corre en transacción y con el lock de abajo (sin él, dos corridas duplicaron importes en
// producción: 1.569 compras de Ramos Mejía ×2/×3, 28-sep y 3-oct-2026).
'use strict';

const { sql, db } = require('../db');
const { normalizarProveedorTexto } = require('../text-normalize');
const { parsearEntidadIdProveedorTexto, construirEntidadIdProveedorTexto, candidatosEntidadIdProveedor } = require('../proveedor-entidad-id');
const { calcularDistribuciones } = require('./calculo');
const { resolverVigencia, vigenciaToSql, fechaEnVigencia, FECHA_EFECTIVA_COMPRA_SQL } = require('./vigencia');
const { encontrarSuperposicion } = require('./validaciones');
const { seleccionarReglasCandidatas } = require('./cascada');

// registro > proveedor > concepto: número más alto gana.
const PRIORIDAD_NIVEL = { registro: 3, proveedor: 2, concepto: 1 };
const compararPrioridadNivel = (a, b) => PRIORIDAD_NIVEL[b.nivel] - PRIORIDAD_NIVEL[a.nivel];

const FLUSH_THRESHOLD = 5000; // filas por INSERT: cada una usa 7 parámetros (tope de Postgres: 65535)
const APERTURA_LOCK_KEY = 7281001;

// Serializa las corridas de una organización. De transacción: se suelta solo al commit o rollback.
const tomarLockDeAplicacion = (tx, organizationId) =>
  tx.execute(sql`SELECT pg_advisory_xact_lock(${APERTURA_LOCK_KEY}::int, ${organizationId}::int)`);

function condicionMatchNivel(nivel, entidadId) {
  if (nivel === 'proveedor') {
    // "texto:" = proveedor de texto crudo del ERP; "|codigo:" separa personas con el mismo nombre.
    const parsed = parsearEntidadIdProveedorTexto(entidadId);
    if (parsed !== null) {
      return parsed.codigo !== null
        ? sql`(c."proveedorId" IS NULL AND c."proveedorTextoNormalizado" = ${parsed.normalizado} AND c."codigo" = ${parsed.codigo})`
        : sql`(c."proveedorId" IS NULL AND c."proveedorTextoNormalizado" = ${parsed.normalizado})`;
    }
    return sql`c."proveedorId"::text = ${entidadId}`;
  }
  if (nivel === 'registro') return sql`c."rowId" = ${entidadId}`;
  if (nivel === 'concepto') return sql`COALESCE(c."conceptoCodigoManual", c."conceptoCodigo") = ${entidadId}`;
  throw new Error(`Nivel de regla desconocido: ${nivel}`);
}

const filtroOrigenSql = (origen) =>
  sql`c.business_id = ${origen.businessId} AND c.branch_id IS NOT DISTINCT FROM ${origen.branchId}::bigint`;

// Compras elegibles: compartido entre aplicarRegla y el preview, para que nunca diverjan.
// reglaEnEdicionId relaja esDistribuido en el preview de una edición (si no, daría $0).
function condicionComprasElegibles(nivel, entidadId, vigenciaSql, origen, reglaEnEdicionId, soloRowIds) {
  const filtroDistribuido = reglaEnEdicionId != null
    ? sql`(c."esDistribuido" = false OR EXISTS (
        SELECT 1 FROM gestion_distribuciones_apertura da
        WHERE da.compra_business_id = c.business_id AND da."compraRowId" = c."rowId" AND da."reglaId" = ${reglaEnEdicionId}
      ))`
    : sql`c."esDistribuido" = false`;
  const filtroRowIds = soloRowIds != null ? sql`AND c."rowId" = ANY(${soloRowIds}::text[])` : sql``;
  return sql`
    SELECT c."rowId", COALESCE(c."importeManual", c.importe) AS "importeBase", ${FECHA_EFECTIVA_COMPRA_SQL} AS "fechaEfectiva"
    FROM gestion_compras c
    WHERE ${condicionMatchNivel(nivel, entidadId)}
      AND c."esBloqueado" = false
      AND ${filtroDistribuido}
      AND ${filtroOrigenSql(origen)}
      AND COALESCE(c."importeManual", c.importe) IS NOT NULL
      AND (${vigenciaSql})
      ${filtroRowIds}`;
}

class SuperposicionError extends Error {
  constructor(reglaId) {
    super(`Superposición con la regla existente #${reglaId}`);
    this.reglaId = reglaId;
  }
}

// Dentro de la transacción y con el lock tomado: dos reglas del mismo origen no compiten por la misma
// plata. Dos reglas del mismo concepto para orígenes distintos conviven.
async function verificarSinSuperposicion(tx, organizationId, nivel, entidadId, vigenciaNueva, origen, excluirId) {
  const existentes = await tx.many(sql`
    SELECT id, modo, "fechaDesde", "fechaHasta", "extremosInclusivos" FROM gestion_reglas_apertura
    WHERE organization_id = ${organizationId} AND "entidadId" = ${entidadId} AND nivel = ${nivel} AND estado = 'activa'
      AND business_id = ${origen.businessId} AND branch_id IS NOT DISTINCT FROM ${origen.branchId}::bigint
      AND (${excluirId ?? null}::int IS NULL OR id <> ${excluirId ?? null}::int)`);
  const conflicto = encontrarSuperposicion(vigenciaNueva, existentes);
  if (conflicto !== null) throw new SuperposicionError(conflicto);
}

async function revertirCompras(tx, businessId, rowIds) {
  if (!rowIds.length) return;
  await tx.execute(sql`DELETE FROM gestion_distribuciones_apertura WHERE compra_business_id = ${businessId} AND "compraRowId" = ANY(${rowIds}::text[])`);
  await tx.execute(sql`
    UPDATE gestion_compras SET "esDistribuido" = false, "distribuidoEn" = NULL
    WHERE business_id = ${businessId} AND "rowId" = ANY(${rowIds}::text[])`);
}

// Antes de que una regla de más prioridad reclame compras, se ceden las tomadas por una de menos
// (también si está desactivada: si no, esas compras quedarían bloqueadas para siempre).
async function liberarComprasReclamables(tx, nivel, entidadId, vigenciaSql, origen) {
  const menores = Object.entries(PRIORIDAD_NIVEL).filter(([, p]) => p < PRIORIDAD_NIVEL[nivel]).map(([n]) => n);
  if (!menores.length) return;
  const filas = await tx.many(sql`
    SELECT DISTINCT c."rowId"
    FROM gestion_compras c
    JOIN gestion_distribuciones_apertura da ON da.compra_business_id = c.business_id AND da."compraRowId" = c."rowId"
    JOIN gestion_reglas_apertura ra ON ra.id = da."reglaId"
    WHERE ${condicionMatchNivel(nivel, entidadId)}
      AND c."esBloqueado" = false
      AND ${filtroOrigenSql(origen)}
      AND COALESCE(c."importeManual", c.importe) IS NOT NULL
      AND (${vigenciaSql})
      AND ra.nivel = ANY(${menores}::text[])`);
  await revertirCompras(tx, origen.businessId, filas.map((f) => f.rowId));
}

const insertarDistribuciones = (tx, filas) => tx.execute(sql`
  INSERT INTO gestion_distribuciones_apertura (compra_business_id, "compraRowId", "reglaId", "destinoId", "importeOriginal", porcentaje, "importeCalculado")
  VALUES ${sql.join(filas, ", ")}`);

// Siempre dentro de una transacción. Sobre el importe EFECTIVO.
async function aplicarRegla(tx, organizationId, input) {
  await tomarLockDeAplicacion(tx, organizationId);
  const vigenciaSql = vigenciaToSql(resolverVigencia(input.vigencia), FECHA_EFECTIVA_COMPRA_SQL);
  const compras = await tx.many(condicionComprasElegibles(input.nivel, input.entidadId, vigenciaSql, input.origen, null, input.soloRowIds));
  if (!compras.length || !input.destinos.length) return { comprasAfectadas: 0 };
  const porcentajes = new Map(input.destinos.map((d) => [d.id, d.porcentaje]));
  let filas = [];
  for (const compra of compras) {
    // A 2 decimales antes de repartir: la tabla es NUMERIC(14,2) y si redondea Postgres se rompe la suma exacta.
    const importeBase = Math.round(Number(compra.importeBase) * 100) / 100;
    for (const d of calcularDistribuciones(importeBase, input.destinos)) {
      filas.push(sql`(${input.origen.businessId}, ${compra.rowId}, ${input.reglaId}, ${d.destinoId},
        ${importeBase}::numeric, ${porcentajes.get(d.destinoId)}::numeric, ${d.importeCalculado}::numeric)`);
    }
    if (filas.length >= FLUSH_THRESHOLD) { await insertarDistribuciones(tx, filas); filas = []; }
  }
  if (filas.length) await insertarDistribuciones(tx, filas);
  await tx.execute(sql`
    UPDATE gestion_compras SET "esDistribuido" = true, "distribuidoEn" = CURRENT_TIMESTAMP
    WHERE business_id = ${input.origen.businessId} AND "rowId" = ANY(${compras.map((c) => c.rowId)}::text[])`);
  return { comprasAfectadas: compras.length };
}

// Borra lo repartido por una regla y recalcula esDistribuido según lo que le quede a cada compra.
async function revertirRegla(tx, reglaId) {
  const afectadas = await tx.many(sql`
    SELECT DISTINCT compra_business_id AS biz, "compraRowId" AS "rowId" FROM gestion_distribuciones_apertura WHERE "reglaId" = ${reglaId}`);
  await tx.execute(sql`DELETE FROM gestion_distribuciones_apertura WHERE "reglaId" = ${reglaId}`);
  if (!afectadas.length) return { comprasRevertidas: 0, rowIds: [] };
  const hay = sql`EXISTS (SELECT 1 FROM gestion_distribuciones_apertura da WHERE da.compra_business_id = c.business_id AND da."compraRowId" = c."rowId")`;
  const porNegocio = new Map();
  for (const a of afectadas) porNegocio.set(String(a.biz), [...(porNegocio.get(String(a.biz)) ?? []), a.rowId]);
  for (const [biz, rowIds] of porNegocio) {
    await tx.execute(sql`
      UPDATE gestion_compras c SET "esDistribuido" = ${hay}, "distribuidoEn" = CASE WHEN ${hay} THEN c."distribuidoEn" ELSE NULL END
      WHERE c.business_id = ${biz}::bigint AND c."rowId" = ANY(${rowIds}::text[])`);
  }
  return { comprasRevertidas: afectadas.length, rowIds: afectadas.map((a) => a.rowId) };
}

const claveCompra = sql`COALESCE(c."conceptoCodigoManual", c."conceptoCodigo") AS "conceptoEfectivo", c."proveedorId", c."proveedorTextoNormalizado", c."codigo"`;

async function cargarComprasSinDistribuir(businessId, reglas) {
  // Agrupado por claves: hay decenas de miles de compras y la mayoría no tiene regla. El rowId es de relleno.
  const porClaves = await db.many(sql`
    SELECT MIN(c."rowId") AS "rowId", ${claveCompra}
    FROM gestion_compras c
    WHERE c.business_id = ${businessId} AND c."esDistribuido" = false AND c."esBloqueado" = false
    GROUP BY 2, 3, 4, 5`);
  const rowIdsRegistro = reglas.filter((r) => r.nivel === 'registro').map((r) => r.entidadId);
  if (!rowIdsRegistro.length) return porClaves;
  const registros = await db.many(sql`
    SELECT c."rowId", ${claveCompra}
    FROM gestion_compras c
    WHERE c.business_id = ${businessId} AND c."esDistribuido" = false AND c."esBloqueado" = false AND c."rowId" = ANY(${rowIdsRegistro}::text[])`);
  return [...porClaves, ...registros];
}

const cargarComprasLiberadas = (businessId, rowIds) => db.many(sql`
  SELECT c."rowId", ${claveCompra} FROM gestion_compras c WHERE c.business_id = ${businessId} AND c."rowId" = ANY(${rowIds}::text[])`);

const destinosPorRegla = async (cliente, ids) => {
  const filas = ids.length ? await cliente.many(sql`SELECT id, "reglaId", porcentaje FROM gestion_destinos_regla WHERE "reglaId" = ANY(${ids}::int[])`) : [];
  const m = new Map();
  for (const d of filas) m.set(d.reglaId, [...(m.get(d.reglaId) ?? []), { id: d.id, porcentaje: Number(d.porcentaje) }]);
  return m;
};

const vigenciaDe = (r) => ({ modo: r.modo, fechaDesde: r.fechaDesde, fechaHasta: r.fechaHasta, extremosInclusivos: r.extremosInclusivos });

// Reaplica las reglas activas cuyo origen es este negocio, en orden de prioridad (aplicarRegla toma lo
// primero que encuentra sin repartir). Con rowIds reevalúa solo esas compras. Cada regla en su propia
// transacción: un fallo no frena al resto y queda en `errores`, nunca se traga.
async function reaplicarReglasActivas({ organizationId, businessId }, opciones = {}) {
  const soloRowIds = opciones.rowIds;
  if (soloRowIds !== undefined && !soloRowIds.length) return { reglasReaplicadas: 0, errores: [] };
  const todas = await db.many(sql`
    SELECT id, nivel, "entidadId", modo, "fechaDesde", "fechaHasta", "extremosInclusivos", business_id, branch_id
    FROM gestion_reglas_apertura WHERE organization_id = ${organizationId} AND business_id = ${businessId} AND estado = 'activa'`);
  if (!todas.length) return { reglasReaplicadas: 0, errores: [] };
  const candidatas = seleccionarReglasCandidatas(
    todas,
    soloRowIds === undefined ? await cargarComprasSinDistribuir(businessId, todas) : await cargarComprasLiberadas(businessId, soloRowIds),
  );
  const destinos = await destinosPorRegla(db, candidatas.map((r) => r.id));
  const errores = [];
  let reglasReaplicadas = 0;
  for (const regla of [...candidatas].sort(compararPrioridadNivel)) {
    try {
      await db.transaction((tx) => aplicarRegla(tx, organizationId, {
        reglaId: regla.id, nivel: regla.nivel, entidadId: regla.entidadId, vigencia: vigenciaDe(regla),
        origen: { businessId: Number(regla.business_id), branchId: regla.branch_id == null ? null : Number(regla.branch_id) },
        destinos: destinos.get(regla.id) ?? [], soloRowIds,
      }));
      reglasReaplicadas += 1;
    } catch (err) {
      errores.push(`aplicarRegla(regla #${regla.id}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { reglasReaplicadas, errores };
}

// Tras importar compras: las ya repartidas que cambiaron en el ERP se revierten (salvo que su regla
// esté inactiva: desactivar preserva el historial) y se reaplica todo. Agarra también las compras nuevas.
async function sincronizarTrasImport({ organizationId, businessId }, comprasModificadas) {
  const errores = [];
  const omitidas = [];
  let comprasRecalculadas = 0;
  if (comprasModificadas.length) {
    const dist = await db.many(sql`
      SELECT DISTINCT ON (da."compraRowId") da."compraRowId", ra.id, ra.estado
      FROM gestion_distribuciones_apertura da JOIN gestion_reglas_apertura ra ON ra.id = da."reglaId"
      WHERE da.compra_business_id = ${businessId} AND da."compraRowId" = ANY(${comprasModificadas}::text[])
      ORDER BY da."compraRowId", da.id DESC`);
    const porRow = new Map(dist.map((d) => [d.compraRowId, d]));
    const aRevertir = [];
    for (const rowId of comprasModificadas) {
      const d = porRow.get(rowId);
      if (d?.estado === 'inactiva') {
        omitidas.push(`revertirCompra(${rowId}): omitida, cubierta por la regla inactiva #${d.id}`);
        continue;
      }
      aRevertir.push(rowId);
    }
    if (aRevertir.length) {
      try {
        await db.transaction(async (tx) => {
          await tomarLockDeAplicacion(tx, organizationId);
          await revertirCompras(tx, businessId, aRevertir);
        });
        comprasRecalculadas = aRevertir.length;
      } catch (err) {
        errores.push(`revertirCompras(${aRevertir.length} compras): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  const r = await reaplicarReglasActivas({ organizationId, businessId });
  errores.push(...r.errores);
  return { comprasRecalculadas, reglasReaplicadas: r.reglasReaplicadas, errores, omitidas };
}

function resolverEntidadIdProveedor(compra) {
  if (compra.proveedorId != null) return String(compra.proveedorId);
  return construirEntidadIdProveedorTexto(normalizarProveedorTexto(compra.proveedor), compra.codigo);
}

// Tras editar una compra a mano: revierte lo viejo y aplica la regla que corresponda a su estado
// actual. Siempre dentro de la transacción de la edición: si falla, la edición también se revierte.
async function reevaluarCompra(tx, { organizationId, businessId }, rowId) {
  await tomarLockDeAplicacion(tx, organizationId);
  const compra = await tx.one(sql`
    SELECT branch_id, fecha, "fechaManual", importe, "importeManual", "conceptoCodigo", "conceptoCodigoManual", "proveedorId", proveedor, codigo, "esBloqueado"
    FROM gestion_compras WHERE business_id = ${businessId} AND "rowId" = ${rowId}`);
  if (!compra) return { reevaluada: false, distribuidaAhora: false };
  await revertirCompras(tx, businessId, [rowId]);
  const concepto = compra.conceptoCodigoManual ?? compra.conceptoCodigo;
  const fecha = compra.fechaManual ?? compra.fecha;
  const importe = compra.importeManual ?? compra.importe;
  if (!fecha || importe == null || compra.esBloqueado) return { reevaluada: true, distribuidaAhora: false };

  const branch = compra.branch_id == null ? null : Number(compra.branch_id);
  const niveles = [
    { nivel: 'registro', ids: [rowId] },
    { nivel: 'proveedor', ids: candidatosEntidadIdProveedor(resolverEntidadIdProveedor(compra)) },
    { nivel: 'concepto', ids: concepto != null ? [concepto] : [] },
  ];
  let regla = null;
  for (const { nivel, ids } of niveles) {
    if (!ids.length) continue;
    const candidatas = await tx.many(sql`
      SELECT id, "entidadId", modo, "fechaDesde", "fechaHasta", "extremosInclusivos" FROM gestion_reglas_apertura
      WHERE organization_id = ${organizationId} AND estado = 'activa' AND nivel = ${nivel} AND "entidadId" = ANY(${ids}::text[])
        AND business_id = ${businessId} AND branch_id IS NOT DISTINCT FROM ${branch}::bigint`);
    // El candidato más específico (con código) primero.
    const ordenadas = [...candidatas].sort((a, b) => ids.indexOf(a.entidadId) - ids.indexOf(b.entidadId));
    regla = ordenadas.find((r) => fechaEnVigencia(fecha, vigenciaDe(r))) ?? null;
    if (regla) break;
  }
  if (!regla) return { reevaluada: true, distribuidaAhora: false };
  const destinos = (await destinosPorRegla(tx, [regla.id])).get(regla.id) ?? [];
  if (!destinos.length) return { reevaluada: true, distribuidaAhora: false };
  const importeBase = Math.round(Number(importe) * 100) / 100;
  const porcentajes = new Map(destinos.map((d) => [d.id, d.porcentaje]));
  await insertarDistribuciones(tx, calcularDistribuciones(importeBase, destinos).map((d) => sql`(${businessId}, ${rowId}, ${regla.id}, ${d.destinoId},
    ${importeBase}::numeric, ${porcentajes.get(d.destinoId)}::numeric, ${d.importeCalculado}::numeric)`));
  await tx.execute(sql`UPDATE gestion_compras SET "esDistribuido" = true, "distribuidoEn" = CURRENT_TIMESTAMP WHERE business_id = ${businessId} AND "rowId" = ${rowId}`);
  return { reevaluada: true, distribuidaAhora: true };
}

module.exports = {
  PRIORIDAD_NIVEL, compararPrioridadNivel, SuperposicionError, tomarLockDeAplicacion, condicionMatchNivel,
  condicionComprasElegibles, verificarSinSuperposicion, liberarComprasReclamables, aplicarRegla, revertirRegla,
  revertirCompras, reaplicarReglasActivas, sincronizarTrasImport, reevaluarCompra, resolverEntidadIdProveedor,
};
