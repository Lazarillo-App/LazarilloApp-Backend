// Portado de lazarillo_gestion/app/api/dashboard/pivot/route.ts (misma lógica; la ruta
// HTTP vive en routes/gestionRoutes.js).
//
// Cambios respecto de gestion (multi-negocio, ver docs/integracion-gestion/00-diseno-modelo.md):
// - Todo es del negocio activo; el local/PDV de gestion pasa a ser una sucursal opcional.
// - Los maestros (conceptos, rubros) se buscan en la lista de la organización del negocio y la
//   visibilidad de cada rubro en la del negocio (gestion_rubros_visibilidad, alias `rv`).
// - La composición del tooltip de apertura mira TODA la organización (ver más abajo).
'use strict';

const { sql, db } = require('../db');
const { buildPivotConditions } = require('./query-builders');
const { buildComposicion, buildComposicionPorProveedor } = require('./apertura-composicion');
const { buildPivotDataByProveedor } = require('./pivot-por-proveedor');
const { fuenteCompras } = require('./fuente-compras');

// Empleado con nombre Y apellido para mostrar (Diego 29/10/2026): la compra de un sueldo trae
// en c.proveedor solo el nombre ("Diego"); si coincide con el empleado de ese código y PDV se
// muestra "Diego ALBO". Solo para mostrar: las claves y reglas siguen con el texto crudo.
// PDV de la compra = negocio + sucursal de origen en Lazarillo.
const NOMBRE_EMPLEADO = sql`(
  SELECT NULLIF(TRIM(CONCAT_WS(' ', e.nombre, e.apellido)), '')
  FROM gestion_empleados e
  WHERE c."proveedorId" IS NULL AND e.codigo = c.codigo
    AND e.business_id = c.business_id_origen AND e.branch_id IS NOT DISTINCT FROM c.branch_id_origen
    AND LOWER(TRIM(e.nombre)) = LOWER(TRIM(c.proveedor)) AND e.apellido IS NOT NULL AND TRIM(e.apellido) <> ''
  LIMIT 1)`;

// Maestros de la organización + visibilidad del negocio (en gestion: tres LEFT JOIN globales).
const joinsMaestros = (organizationId, businessId) => sql`
  LEFT JOIN gestion_conceptos_caja cc       ON cc.organization_id = ${organizationId}
                                           AND COALESCE(c."conceptoCodigoManual", c."conceptoCodigo") = cc.codigo
  LEFT JOIN gestion_rubros_concepto_caja rc ON rc.organization_id = ${organizationId} AND cc."codRga" = rc.codigo
  LEFT JOIN gestion_rubros_visibilidad rv   ON rv.business_id = ${businessId} AND rv.codigo = rc.codigo
  LEFT JOIN gestion_proveedores p           ON c."proveedorId" = p.id`;

/**
 * Datos del pivot de Compras del Panel.
 * @param {{ organizationId: number, businessId: number, params: object }} o
 *   params = parseDashboardParams(...) (year, sucursal, months, rubroCodigo, conceptoCodigo,
 *   proveedorId, observacionQuery, importeQuery, vista, agrupacion, modo)
 */
async function obtenerPivot({ organizationId, businessId, params }) {
  const { year, sucursal, rubroCodigo, conceptoCodigo, proveedorId, observacionQuery, importeQuery, months, vista, agrupacion, modo } = params;
  // Económica (por fecha de factura) o Financiera (por fecha de pago): ver fuente-compras.js.
  const fuente = fuenteCompras(modo);
  const visibilidadCol = vista === "resultados" ? "visibleEnResultados" : "visibleEnDashboard";
  const maestros = joinsMaestros(organizationId, businessId);

  const conditions = buildPivotConditions({ year, tableAlias: "c", businessId, sucursal, months, rubroCodigo, conceptoCodigo, proveedorId, observacionQuery, importeQuery, filterRubrosOcultos: true, visibilidadCol });
  const where = sql.join(conditions, " AND ");

  // La composición del tooltip SIEMPRE muestra el reparto completo, aunque el
  // dashboard tenga un filtro de sucursal activo (spec §1.1 y §8 de gestion): en la rama
  // distribuida de la vista, business_id / branch_id son el DESTINO, y filtrar la composición
  // por ellos dejaría una lista de destinos parcial contra el total "100%" (importe original).
  // En gestion se acotaba por el local de ORIGEN (localIdOrigen): Bar y Canchas Ramos eran el
  // mismo local, así que mirando Canchas el tooltip mostraba el reparto de las compras del Bar.
  // En Lazarillo son negocios distintos de la misma organización: se acota por la organización
  // de origen (las reglas de apertura solo reparten dentro de una organización).
  const conditionsComposicion = buildPivotConditions({ year, tableAlias: "c", scopePropio: true, businessId, months, rubroCodigo, conceptoCodigo, proveedorId, observacionQuery, importeQuery, filterRubrosOcultos: true, visibilidadCol });
  conditionsComposicion.push(sql`c.business_id_origen IN (SELECT b.id FROM app_businesses b WHERE b.organization_id = ${organizationId})`);
  const whereComposicion = sql.join(conditionsComposicion, " AND ");

  // Vista Insumos (punto 8 de Etapa 3, Diego 26/10): cada gasto por sus insumos
  // (informe 25) y, si no tiene detalle, por su concepto. Los totales dan igual que
  // por Concepto: el importe de la fila se reparte entre sus líneas en proporción a
  // lo que vale cada una. Las líneas SIN unidad de medida son el concepto mismo (así
  // lista MaxiRest una factura cargada por concepto) y van al concepto.
  // En Lazarillo el detalle se cruza por negocio + sucursal de la compra (en gestion: localId).
  if (agrupacion === "insumo") {
    const filas = await db.many(sql`
      WITH c AS (
        SELECT
          COALESCE(rc.codigo, '__sin_rubro')                                  AS rubro_codigo,
          COALESCE(rc.nombre, 'Sin Rubro')                                   AS rubro_nombre,
          COALESCE(cc.codigo, '__sin_concepto')                              AS concepto_codigo,
          COALESCE(cc.nombre, 'Sin Concepto')                                AS concepto_nombre,
          p.id                                                                AS proveedor_id,
          COALESCE(p.nombre, p.razon, c.proveedor, 'Sin Proveedor')         AS proveedor_nombre,
          c.proveedor                                                        AS proveedor_texto_crudo,
          c.codigo                                                           AS proveedor_codigo,
          ${NOMBRE_EMPLEADO}                                                 AS proveedor_display,
          EXTRACT(MONTH FROM COALESCE(c."fechaManual", c.fecha))::int        AS mes,
          COALESCE(c."importeManual", c.importe)                             AS total,
          c."rowId"                                                           AS row_id,
          c."distribucionId"                                                  AS distribucion_id,
          c."pagoRef"                                                         AS pago_ref,
          TO_CHAR(COALESCE(c."fechaManual", c.fecha), 'YYYY-MM-DD')         AS fecha,
          COALESCE(c."observacManual", c.observac)                           AS observac,
          (c."importeManual" IS NOT NULL OR c."fechaManual" IS NOT NULL
            OR c."conceptoCodigoManual" IS NOT NULL OR c."observacManual" IS NOT NULL) AS has_manual_override,
          c.business_id_origen,
          c.branch_id_origen,
          co.comprobante, co.codigo AS cod_pro, co.business_id AS biz, co.branch_id AS suc, co."codCga" AS cga
        FROM ${fuente} c
        JOIN gestion_compras co           ON co.business_id = c.business_id_origen AND co."rowId" = c."rowId"
        ${maestros}
        WHERE ${where}
      ),
      l AS (
        SELECT d.comprobante, d."codPro", d.business_id, d.branch_id, d."codCga",
          CASE WHEN NULLIF(TRIM(d.medida), '') IS NULL THEN NULL ELSE d.codigo END AS ins,
          MAX(d.nombre) AS nombre,
          SUM(COALESCE(d."totalIns", 0) + COALESCE(d."ivaTot", 0) + COALESCE(d."impNtTot", 0)) AS w
        FROM gestion_detalle_compras d
        WHERE EXISTS (SELECT 1 FROM c WHERE c.comprobante = d.comprobante AND c.cod_pro = d."codPro"
                        AND c.biz = d.business_id AND c.suc IS NOT DISTINCT FROM d.branch_id AND c.cga = d."codCga")
        GROUP BY 1, 2, 3, 4, 5, 6
      ),
      -- Totales por comprobante con ventana (antes, un CTE "lt" aparte): Postgres estima 1 fila en
      -- los CTE y unir c con lt elegía un nested loop de 13 M comparaciones (7-20 s, el tablero quedaba
      -- en blanco en Container Bar, 06/11/2026). Así c se une con una sola tabla, por hash.
      lw AS (
        SELECT l.*,
          SUM(w) OVER k AS wt,
          BOOL_OR(ins IS NOT NULL) OVER k AS con_insumo
        FROM l
        WINDOW k AS (PARTITION BY comprobante, "codPro", business_id, branch_id, "codCga")
      )
      -- Filas con insumos: una por línea, con su parte del importe.
      SELECT c.rubro_codigo, c.rubro_nombre,
        CASE WHEN l.ins IS NULL THEN c.concepto_codigo ELSE 'ins:' || l.ins END AS concepto_codigo,
        CASE WHEN l.ins IS NULL THEN c.concepto_nombre ELSE l.nombre END        AS concepto_nombre,
        c.proveedor_id, c.proveedor_nombre, c.proveedor_texto_crudo, c.proveedor_codigo, c.proveedor_display, c.mes,
        c.total * l.w / l.wt AS total,
        c.row_id, c.distribucion_id,
        COALESCE(c.pago_ref, '') || '|' || COALESCE(l.ins, 'c') AS pago_ref,
        c.fecha, c.observac, c.has_manual_override, c.business_id_origen, c.branch_id_origen
      FROM c
      JOIN lw l ON l.comprobante = c.comprobante AND l."codPro" = c.cod_pro AND l.business_id = c.biz
             AND l.branch_id IS NOT DISTINCT FROM c.suc AND l."codCga" = c.cga
      WHERE l.con_insumo AND l.wt <> 0
      UNION ALL
      -- Sin insumos: por su concepto, como en la vista por Concepto.
      SELECT c.rubro_codigo, c.rubro_nombre, c.concepto_codigo, c.concepto_nombre,
        c.proveedor_id, c.proveedor_nombre, c.proveedor_texto_crudo, c.proveedor_codigo, c.proveedor_display, c.mes,
        c.total, c.row_id, c.distribucion_id, c.pago_ref,
        c.fecha, c.observac, c.has_manual_override, c.business_id_origen, c.branch_id_origen
      FROM c
      WHERE NOT EXISTS (
        SELECT 1 FROM lw
        WHERE lw.comprobante = c.comprobante AND lw."codPro" = c.cod_pro AND lw.business_id = c.biz
          AND lw.branch_id IS NOT DISTINCT FROM c.suc AND lw."codCga" = c.cga
          AND lw.con_insumo AND lw.wt <> 0
      )
      ORDER BY rubro_nombre NULLS LAST, concepto_nombre NULLS LAST, fecha NULLS LAST, proveedor_nombre NULLS LAST
    `);
    return buildPivotData(filas, {});
  }

  const rowsQuery = db.many(sql`
    SELECT
      COALESCE(rc.codigo, '__sin_rubro')                                  AS rubro_codigo,
      COALESCE(rc.nombre, 'Sin Rubro')                                   AS rubro_nombre,
      COALESCE(cc.codigo, '__sin_concepto')                              AS concepto_codigo,
      COALESCE(cc.nombre, 'Sin Concepto')                                AS concepto_nombre,
      p.id                                                                AS proveedor_id,
      COALESCE(p.nombre, p.razon, c.proveedor, 'Sin Proveedor')         AS proveedor_nombre,
      c.proveedor                                                        AS proveedor_texto_crudo,
      c.codigo                                                           AS proveedor_codigo,
      ${NOMBRE_EMPLEADO}                                                 AS proveedor_display,
      EXTRACT(MONTH FROM COALESCE(c."fechaManual", c.fecha))::int        AS mes,
      COALESCE(c."importeManual", c.importe)                             AS total,
      c."rowId"                                                           AS row_id,
      c."distribucionId"                                                  AS distribucion_id,
      c."pagoRef"                                                         AS pago_ref,
      TO_CHAR(COALESCE(c."fechaManual", c.fecha), 'YYYY-MM-DD')         AS fecha,
      COALESCE(c."observacManual", c.observac)                           AS observac,
      (c."importeManual" IS NOT NULL OR c."fechaManual" IS NOT NULL
        OR c."conceptoCodigoManual" IS NOT NULL OR c."observacManual" IS NOT NULL) AS has_manual_override,
      c.business_id_origen,
      c.branch_id_origen
    FROM ${fuente} c
    ${maestros}
    WHERE ${where}
    ORDER BY rubro_nombre NULLS LAST, concepto_nombre NULLS LAST, COALESCE(c."fechaManual", c.fecha) NULLS LAST, proveedor_nombre NULLS LAST
  `);

  // Composición para el tooltip de conceptos aperturados: descompone el importe
  // efectivo por destino (concepto efectivo + mes + destino). Solo la rama
  // distribuida de la vista (`c."distribucionId" IS NOT NULL`). Usa `whereComposicion`
  // (ver comentario arriba), con el mismo set de LEFT JOIN (cc / rc / rv / p) que el query
  // principal para resolver sus predicados de rubro, concepto y proveedor.
  const composicionDestinosQuery = db.many(sql`
    SELECT
      COALESCE(cc.codigo, '__sin_concepto')                        AS concepto_codigo,
      EXTRACT(MONTH FROM COALESCE(c."fechaManual", c.fecha))::int  AS mes,
      -- Sucursal calificada por su negocio ("Negocio — Sucursal"): en gestion "Local — PDV",
      -- porque los nombres de PDV se repiten entre locales (ver describirOrigen).
      CASE
        WHEN br.name IS NOT NULL THEN COALESCE(b.name || ' — ', '') || br.name
        ELSE COALESCE(b.name, 'Sin destino')
      END                                                         AS destino_nombre,
      p.id                                                          AS proveedor_id,
      COALESCE(p.nombre, p.razon, c.proveedor, 'Sin Proveedor')   AS proveedor_nombre,
      c.codigo                                                     AS proveedor_codigo,
      da.porcentaje                                                AS pct,
      SUM(da."importeCalculado")                                   AS importe_calculado
    FROM ${fuente} c
    JOIN gestion_distribuciones_apertura da ON da.id = c."distribucionId"
    JOIN gestion_destinos_regla dr          ON dr.id = da."destinoId"
    LEFT JOIN app_businesses b              ON b.id = dr.business_id
    LEFT JOIN app_branches br               ON br.id = dr.branch_id
    ${maestros}
    WHERE c."distribucionId" IS NOT NULL AND ${whereComposicion}
    GROUP BY concepto_codigo, proveedor_id, proveedor_nombre, proveedor_codigo, mes, destino_nombre, da.porcentaje
  `);

  // Total "100%" del tooltip = importe original de la compra, deduplicado por
  // compra: en el fan-out de la vista `importeOriginal` se repite en cada fila
  // de destino, así que primero un SELECT DISTINCT por (concepto, mes, compra)
  // y recién después el SUM.
  const composicionOriginalesQuery = db.many(sql`
    SELECT concepto_codigo, proveedor_id, proveedor_nombre, proveedor_codigo, mes, SUM(importe_original) AS importe_original
    FROM (
      SELECT DISTINCT
        COALESCE(cc.codigo, '__sin_concepto')                       AS concepto_codigo,
        p.id                                                          AS proveedor_id,
        COALESCE(p.nombre, p.razon, c.proveedor, 'Sin Proveedor')   AS proveedor_nombre,
        c.codigo                                                     AS proveedor_codigo,
        EXTRACT(MONTH FROM COALESCE(c."fechaManual", c.fecha))::int AS mes,
        da.compra_business_id,
        da."compraRowId",
        da."importeOriginal"                                        AS importe_original
      FROM ${fuente} c
      JOIN gestion_distribuciones_apertura da ON da.id = c."distribucionId"
      ${maestros}
      WHERE c."distribucionId" IS NOT NULL AND ${whereComposicion}
    ) dedup
    GROUP BY concepto_codigo, proveedor_id, proveedor_nombre, proveedor_codigo, mes
  `);

  // Los tres queries son independientes entre sí y el pool reparte conexiones — se
  // corren en paralelo para no triplicar la latencia de cada carga del dashboard.
  const [rows, composicionDestinos, composicionOriginales] = await Promise.all([
    rowsQuery,
    composicionDestinosQuery,
    composicionOriginalesQuery,
  ]);

  if (agrupacion === "proveedor") {
    const composicionPorProveedor = buildComposicionPorProveedor(composicionDestinos, composicionOriginales);
    return buildPivotDataByProveedor(rows, composicionPorProveedor);
  }

  const composicion = buildComposicion(composicionDestinos, composicionOriginales);
  return buildPivotData(rows, composicion);
}

function buildPivotData(sqlRows, composicion) {
  const rubroMap = new Map();
  const conceptoMap = new Map();

  for (const row of sqlRows) {
    const {
      rubro_codigo,
      rubro_nombre,
      concepto_codigo,
      concepto_nombre,
      proveedor_id,
      proveedor_nombre,
      mes,
      total,
      row_id,
      distribucion_id,
      pago_ref,
      fecha,
      observac,
      has_manual_override,
      business_id_origen,
      branch_id_origen,
    } = row;

    const t = typeof total === "object" && total !== null
      ? Number(total.toString())
      : Number(total);

    const concKey = `${rubro_codigo}|${concepto_codigo}`;

    if (!rubroMap.has(rubro_codigo)) {
      rubroMap.set(rubro_codigo, {
        level: 0,
        id: rubro_codigo,
        nombre: rubro_nombre,
        rubroCodigo: rubro_codigo,
        values: {},
        rowTotal: 0,
        children: [],
      });
    }
    const rubro = rubroMap.get(rubro_codigo);

    if (!conceptoMap.has(concKey)) {
      const concepto = {
        level: 1,
        id: concKey,
        nombre: concepto_nombre,
        conceptoCodigo: concepto_codigo,
        rubroCodigo: rubro_codigo,
        values: {},
        rowTotal: 0,
        children: [],
        composicion: composicion[concepto_codigo],
      };
      conceptoMap.set(concKey, concepto);
      rubro.children.push(concepto);
    }
    const concepto = conceptoMap.get(concKey);

    const provRow = {
      level: 2,
      // En Financiera una factura puede venir en varias filas (una por pago).
      id: `${concKey}|${row_id}|${distribucion_id ?? "orig"}${pago_ref ? `|${pago_ref}` : ""}`,
      rowId: row_id,
      distribucionId: distribucion_id,
      nombre: row.proveedor_display ?? proveedor_nombre,
      fecha: fecha ?? null,
      observac: observac ?? null,
      importe: t,
      proveedorId: proveedor_id,
      conceptoCodigo: concepto_codigo,
      rubroCodigo: rubro_codigo,
      hasManualOverride: !!has_manual_override,
      businessIdOrigen: business_id_origen != null ? Number(business_id_origen) : null, // en gestion: localIdOrigen
      branchIdOrigen: branch_id_origen != null ? Number(branch_id_origen) : null,       // en gestion: puntoDeVentaIdOrigen
      values: { [mes]: t },
      rowTotal: t,
    };
    concepto.children.push(provRow);
  }

  // Roll up values bottom-up: proveedor → concepto → rubro
  for (const [, rubro] of rubroMap) {
    for (const concepto of rubro.children) {
      for (const prov of concepto.children) {
        for (const [m, val] of Object.entries(prov.values)) {
          const mn = Number(m);
          concepto.values[mn] = (concepto.values[mn] ?? 0) + val;
        }
        concepto.rowTotal += prov.rowTotal;
      }
      for (const [m, val] of Object.entries(concepto.values)) {
        const mn = Number(m);
        rubro.values[mn] = (rubro.values[mn] ?? 0) + val;
      }
      rubro.rowTotal += concepto.rowTotal;
    }
  }

  const columnTotals = {};
  let grandTotal = 0;
  for (const [, rubro] of rubroMap) {
    for (const [m, val] of Object.entries(rubro.values)) {
      const mn = Number(m);
      columnTotals[mn] = (columnTotals[mn] ?? 0) + val;
    }
    grandTotal += rubro.rowTotal;
  }

  return { rows: Array.from(rubroMap.values()), columnTotals, grandTotal };
}

module.exports = { obtenerPivot, buildPivotData };
