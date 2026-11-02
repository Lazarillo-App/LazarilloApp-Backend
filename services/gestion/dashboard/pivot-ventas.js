// Portado de lazarillo_gestion/app/api/dashboard/pivot-ventas/route.ts (misma lógica; la ruta
// HTTP vive en routes/gestionRoutes.js). Ventas del informe 22 por tipo → forma de cobro → mes.
// En Lazarillo: ventas del negocio activo, con la sucursal como filtro opcional.
'use strict';

const { sql, db } = require('../db');
const { buildPivotConditions } = require('./query-builders');
const { toNumber } = require('./pivot-utils');
const { SIN_TIPO_CODE, SIN_TIPO_NOMBRE, SIN_COBRO_CODE, SIN_COBRO_NOMBRE } = require('./constants');

/**
 * @param {{ businessId: number, params: object }} o  params = parseVentasParams(...)
 */
async function obtenerPivotVentas({ businessId, params }) {
  const { year, sucursal, months } = params;
  const conditions = buildPivotConditions({ year, tableAlias: "v", hasFechaManual: false, businessId, sucursal, months });
  const where = sql.join(conditions, " AND ");

  const rows = await db.many(sql`
    SELECT
      COALESCE(v.tipo, ${SIN_TIPO_CODE})        AS tipo_codigo,
      COALESCE(v.tipo, ${SIN_TIPO_NOMBRE})       AS tipo_nombre,
      COALESCE(v."codCobro", ${SIN_COBRO_CODE})  AS cobro_codigo,
      COALESCE(v.cobro, ${SIN_COBRO_NOMBRE})     AS cobro_nombre,
      EXTRACT(MONTH FROM v.fecha)::int           AS mes,
      SUM(COALESCE(v."importeManual", v.importe)) AS total
    FROM gestion_ventas v
    WHERE ${where}
    GROUP BY v.tipo, v."codCobro", v.cobro, EXTRACT(MONTH FROM v.fecha)::int
    ORDER BY tipo_nombre NULLS LAST, cobro_nombre NULLS LAST, mes
  `);

  return buildPivotData(rows);
}

function buildPivotData(sqlRows) {
  const tipoMap = new Map();
  const cobroMap = new Map();

  for (const row of sqlRows) {
    const { tipo_codigo, tipo_nombre, cobro_codigo, cobro_nombre, mes } = row;
    const t = toNumber(row.total);
    const cobroKey = `${tipo_codigo}|${cobro_codigo}`;

    if (!tipoMap.has(tipo_codigo)) {
      tipoMap.set(tipo_codigo, {
        level: 0,
        id: tipo_codigo,
        nombre: tipo_nombre,
        rubroCodigo: tipo_codigo,
        values: {},
        rowTotal: 0,
        children: [],
      });
    }
    const tipo = tipoMap.get(tipo_codigo);

    if (!cobroMap.has(cobroKey)) {
      const cobroRow = {
        level: 1,
        id: cobroKey,
        nombre: cobro_nombre,
        conceptoCodigo: cobro_codigo,
        rubroCodigo: tipo_codigo,
        values: {},
        rowTotal: 0,
        children: [],
      };
      cobroMap.set(cobroKey, cobroRow);
      tipo.children.push(cobroRow);
    }
    const cobro = cobroMap.get(cobroKey);

    cobro.values[mes] = (cobro.values[mes] ?? 0) + t;
    cobro.rowTotal += t;
  }

  for (const [, tipo] of tipoMap) {
    for (const cobro of tipo.children) {
      for (const [m, val] of Object.entries(cobro.values)) {
        const mn = Number(m);
        tipo.values[mn] = (tipo.values[mn] ?? 0) + val;
      }
      tipo.rowTotal += cobro.rowTotal;
    }
  }

  const columnTotals = {};
  let grandTotal = 0;
  for (const [, tipo] of tipoMap) {
    for (const [m, val] of Object.entries(tipo.values)) {
      const mn = Number(m);
      columnTotals[mn] = (columnTotals[mn] ?? 0) + val;
    }
    grandTotal += tipo.rowTotal;
  }

  return { rows: Array.from(tipoMap.values()), columnTotals, grandTotal };
}

module.exports = { obtenerPivotVentas, buildPivotData };
