// Portado de lazarillo_gestion/lib/dashboard/query-builders.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { sql } = require('../db');
const { SIN_RUBRO_VISIBILIDAD_DEFAULT, VISIBILIDAD_FIELDS } = require('./constants');
const { ACENTOS_DESDE, ACENTOS_HACIA, quitarAcentos } = require('./observacion-busqueda');
const { parsearImporte } = require('./importe-busqueda');
const { decimalCanonico } = require('../decimal-canonico');

function buildDateRange(year, mes) {
  const fechaStart = mes ? new Date(Date.UTC(year, mes - 1, 1)) : new Date(Date.UTC(year, 0, 1));
  const fechaEnd   = mes ? new Date(Date.UTC(year, mes, 1))     : new Date(Date.UTC(year + 1, 0, 1));
  return { fechaStart, fechaEnd };
}

/** `expr` dentro del año (timestamp sin zona, como fecha/fechaManual). Usa los índices de fecha. */
function rangoAnio(expr, year) {
  return sql`${expr} >= ${`${year}-01-01`}::timestamp AND ${expr} < ${`${year + 1}-01-01`}::timestamp`;
}

// Flag de visibilidad del bucket "Sin Rubro" (sin_rubro_config, una sola fila). COALESCE al default
// si la fila falta: ante una config rota preferimos mostrar el dato antes que ocultarlo en silencio.
// El literal del default sale de una constante nuestra (no de input), por eso va con sql.raw.
// En Lazarillo la config es por negocio (gestion_sin_rubro_config, una fila por business_id).
function sinRubroVisibleSql(col, businessId) {
  const safe = VISIBILIDAD_FIELDS.includes(col) ? col : "visibleEnDashboard";
  const fallback = SIN_RUBRO_VISIBILIDAD_DEFAULT[safe] ? "true" : "false";
  return sql`COALESCE((SELECT s."${sql.raw(safe)}" FROM gestion_sin_rubro_config s WHERE s.business_id = ${businessId}), ${sql.raw(fallback)})`;
}

// Visibilidad de un rubro (rc) en el Panel del negocio. En gestion vivía en el maestro de rubros;
// en Lazarillo el maestro es de la organización y la visibilidad es de cada negocio
// (gestion_rubros_visibilidad), así que la consulta tiene que unir `rv`:
//   LEFT JOIN gestion_rubros_visibilidad rv ON rv.business_id = <negocio> AND rv.codigo = rc.codigo
// Sin fila de visibilidad vale el default que tenían las columnas en gestion.
const RUBRO_VISIBILIDAD_DEFAULT = { visibleEnDashboard: true, visibleEnResultados: false };
function rubroVisibleSql(col) {
  const safe = VISIBILIDAD_FIELDS.includes(col) ? col : "visibleEnDashboard";
  return sql`COALESCE(rv."${sql.raw(safe)}", ${sql.raw(RUBRO_VISIBILIDAD_DEFAULT[safe] ? "true" : "false")})`;
}

// Filtro de negocio + sucursal (en gestion: local / PDV). sucursal: undefined = todas,
// null = la principal (branch_id NULL), número = esa sucursal.
function filtroSucursalSql(t, businessId, sucursal) {
  const base = sql`${sql.raw(t)}.business_id = ${businessId}`;
  if (sucursal === undefined) return base;
  return sucursal === null
    ? sql`${base} AND ${sql.raw(t)}.branch_id IS NULL`
    : sql`${base} AND ${sql.raw(t)}.branch_id = ${sucursal}`;
}

// Búsqueda por contenido en la observación efectiva (manual si existe), sin acentos de ningún lado y
// con los comodines de LIKE escapados. Compartida entre el pivot y el detalle: si filtraran distinto,
// la suma del modal no coincidiría con el total clickeado.
function observacionCondition(t, query) {
  const q = `%${quitarAcentos(query).replace(/[%_\\]/g, "\\$&")}%`;
  return sql`translate(COALESCE(${sql.raw(t)}."observacManual", ${sql.raw(t)}.observac), ${ACENTOS_DESDE}, ${ACENTOS_HACIA}) ILIKE ${q}`;
}

// Búsqueda por importe (punto 9 de Etapa 3): compras cuyo importe COMPLETO coincide con lo
// tipeado — exacto si se tiparon centavos, por parte entera si no; el signo se ignora para
// encontrar también notas de crédito. Va por subconsulta sobre `compras` y no sobre el alias:
// en v_compras_distribuidas una compra aperturada aparece con la parte de cada destino, y lo
// que se rastrea es el total del gasto (el que figura en el banco). Compartida entre pivot,
// detalle y el buscador. Devuelve null si lo tipeado no es un importe (se ignora el filtro).
// Sin Prisma.Decimal: sin centavos el valor es un entero (el +1 no pierde precisión hasta 2^53).
function importeCondition(t, query) {
  const buscado = parsearImporte(query);
  if (!buscado) return null;
  const valor = decimalCanonico(buscado.valor) ?? String(buscado.valor); // como new Prisma.Decimal(valor)
  const abs = sql`ABS(COALESCE(co."importeManual", co.importe))`;
  const match = buscado.conCentavos
    ? sql`${abs} = ${valor}::numeric`
    : sql`${abs} >= ${valor}::numeric AND ${abs} < ${String(Number(valor) + 1)}::numeric`;
  return sql`${sql.raw(t)}."rowId" IN (SELECT co."rowId" FROM gestion_compras co WHERE ${match})`;
}

function buildPivotConditions({
  year,
  tableAlias: t,
  hasFechaManual = true,
  hasImporteManual = true,
  businessId,
  sucursal,
  scopePropio = false,
  months,
  rubroCodigo,
  conceptoCodigo,
  proveedorId,
  observacionQuery,
  importeQuery,
  filterRubrosOcultos = false,
  visibilidadCol = "visibleEnDashboard",
}) {
  const fechaExpr = hasFechaManual
    ? sql`COALESCE(${sql.raw(t)}."fechaManual", ${sql.raw(t)}.fecha)`
    : sql`${sql.raw(t)}.fecha`;

  const dateGuard = hasFechaManual
    ? sql`(${sql.raw(t)}.fecha IS NOT NULL OR ${sql.raw(t)}."fechaManual" IS NOT NULL)`
    : sql`${sql.raw(t)}.fecha IS NOT NULL`;

  const importeExpr = hasImporteManual
    ? sql`COALESCE(${sql.raw(t)}."importeManual", ${sql.raw(t)}.importe)`
    : sql`${sql.raw(t)}.importe`;

  const conditions = [
    dateGuard,
    sql`${sql.raw(t)}.importe IS NOT NULL`,
    sql`${importeExpr} != 0`,
  ];
  // El año va como rango (>= 1/1 y < 1/1 del siguiente), no como EXTRACT(YEAR …) = año: así
  // Postgres usa los índices de fecha y no recorre la tabla entera (Diego 29/10/2026: "le
  // cuesta bastante cargar los datos" — 3 s → 0,1 s por consulta). Mismo resultado.
  if (year !== undefined) conditions.unshift(rangoAnio(fechaExpr, year));
  // En gestion: localId / pdvId opcionales. En Lazarillo el negocio es obligatorio (lo que se ve
  // es siempre del negocio activo) y la sucursal es un filtro opcional dentro de él.
  // scopePropio: el llamador acota él mismo (ej. la composición de la apertura, que mira toda
  // la organización) — tiene que agregar su propia condición de negocio/organización.
  if (scopePropio !== true) {
    if (businessId == null) throw new Error("buildPivotConditions: falta businessId");
    conditions.push(filtroSucursalSql(t, businessId, sucursal));
  }
  if (months?.length) {
    conditions.push(
      sql`EXTRACT(MONTH FROM ${fechaExpr})::int IN (${sql.join(months.map((m) => sql`${m}`))})`
    );
  }
  if (rubroCodigo) {
    conditions.push(sql`COALESCE(rc.codigo, '__sin_rubro') = ${rubroCodigo}`);
  } else if (filterRubrosOcultos) {
    // Whitelist estricta: visibilidadCol nunca debe construirse a partir de un string arbitrario del request.
    const col = VISIBILIDAD_FIELDS.includes(visibilidadCol)
      ? (visibilidadCol)
      : "visibleEnDashboard";
    conditions.push(
      sql`((rc.codigo IS NOT NULL AND ${rubroVisibleSql(col)}) OR (rc.codigo IS NULL AND ${sinRubroVisibleSql(col, businessId)}))`
    );
  }
  if (conceptoCodigo) conditions.push(sql`COALESCE(cc.codigo, '__sin_concepto') = ${conceptoCodigo}`);
  if (proveedorId) conditions.push(sql`p.id = ${proveedorId}`);
  if (observacionQuery) conditions.push(observacionCondition(t, observacionQuery));
  if (importeQuery) {
    const cond = importeCondition(t, importeQuery);
    if (cond) conditions.push(cond);
  }
  return conditions;
}

module.exports = { buildDateRange, rangoAnio, sinRubroVisibleSql, rubroVisibleSql, filtroSucursalSql, observacionCondition, importeCondition, buildPivotConditions };
