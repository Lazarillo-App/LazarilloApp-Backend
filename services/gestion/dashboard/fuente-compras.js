// Portado de lazarillo_gestion/lib/dashboard/fuente-compras.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { sql } = require('../db');
const { impagasDesde } = require('../impagas/query');

// Switch Económica / Financiera del panel (punto 4 de Etapa 3, Diego 26/10/2026).
//
// Las consultas del panel leen las compras de `v_compras_distribuidas` y ubican
// cada fila en el mes de COALESCE(fechaManual, fecha). Esta función devuelve la
// fuente a usar en lugar de la vista, con las MISMAS columnas (+ "pagoRef"), y
// según el modo cambia qué fecha (e importe) cuenta:
//
// ECONÓMICA (por fecha de factura):
//   - Sueldos (E): el mes que liquidan (PERIODO del 14), no el día que se pagaron.
//   - Una fecha editada en Lazarillo (fechaManual) sigue mandando.
//
// FINANCIERA (por fecha de pago):
//   - Gastos varios y sueldos: FECHA_PAGO del 14 (si la PC todavía no la trae, la fecha del gasto).
//   - Facturas: una fila por cada pago del informe 80, en el mes del pago, por la
//     parte que ese pago cubre (importe de la fila × pago / total del comprobante).
//     Una factura impaga no suma; una parcial suma solo lo pagado.
//   - Sin pagos pero cuentan en su fecha: notas de crédito, proveedores con pago
//     automático y comprobantes anteriores a la cobertura del 80 (IMPAGAS_DESDE).
//   - Los ingresos NO cambian (Diego: todavía no hay detalle de cobros por forma de pago).

function esModoPanel(v) {
  return v === "economica" || v === "financiera";
}

const COLS = (b) => sql.raw(`
  ${b}."rowId", ${b}."distribucionId", ${b}.business_id, ${b}.branch_id,
  ${b}.business_id_origen, ${b}.branch_id_origen,
  ${b}."conceptoCodigo", ${b}."conceptoCodigoManual", ${b}.concepto, ${b}.detalle,
  ${b}.observac, ${b}."observacManual", ${b}.proveedor, ${b}."proveedorId", ${b}.codigo`);

// Rendimiento (revisión 27/10/2026): la vista ya trae periodo, comprobante y
// fechaPago (no se vuelve a juntar con compras), y en Financiera la base es NOT
// MATERIALIZED para que el filtro de PDV / local / año llegue hasta las tablas en
// vez de armar las ~80 mil filas en cada consulta; los pagos se cruzan por índice y
// el total del 14 solo se calcula cuando el 80 no lo trae. Mismas filas que antes.
function fuenteCompras(modo, desde = impagasDesde(null, process.env.IMPAGAS_DESDE)) {
  if (modo !== "financiera") {
    return sql`(
      SELECT ${COLS("v")},
        v.importe, v."importeManual",
        COALESCE(v.periodo, v.fecha) AS fecha, v."fechaManual",
        NULL::text AS "pagoRef"
      FROM gestion_v_compras_distribuidas v
    )`;
  }
  return sql`(
    WITH base AS NOT MATERIALIZED (
      SELECT v.*,
        v.comprobante                           AS comp,
        v."fechaPago"                           AS fpago,
        -- PDV donde se cargó la compra = negocio + sucursal de origen en Lazarillo
        v.business_id_origen                    AS biz_compra,
        v.branch_id_origen                      AS suc_compra,
        (v.comprobante IS NULL OR v.codigo IS NULL
          OR UPPER(LEFT(v.comprobante, 1)) IN ('E', 'G'))  AS es_gv,
        COALESCE(pr."pagoAutomatico", false)    AS auto
      FROM gestion_v_compras_distribuidas v
      LEFT JOIN gestion_proveedores pr  ON pr.id = v."proveedorId"
    )
    -- Gastos varios y sueldos: por su fecha de pago.
    SELECT ${COLS("b")},
      b.importe, b."importeManual",
      COALESCE(b.fpago, b."fechaManual", b.fecha) AS fecha, NULL::timestamp(3) AS "fechaManual",
      NULL::text AS "pagoRef"
    FROM base b
    WHERE b.es_gv
    UNION ALL
    -- Facturas con pagos en el 80: una fila por pago, por la parte que cubre.
    SELECT ${COLS("b")},
      COALESCE(b."importeManual", b.importe) * pg.importe
        / COALESCE(NULLIF(pg.total, 0), NULLIF((
            SELECT SUM(COALESCE(x."importeManual", x.importe)) FROM gestion_compras x
            WHERE x.business_id = b.biz_compra AND x.branch_id IS NOT DISTINCT FROM b.suc_compra AND x.comprobante = b.comp AND x.codigo = b.codigo
          ), 0))  AS importe,
      NULL::numeric AS "importeManual",
      pg."fechaPago" AS fecha, NULL::timestamp(3) AS "fechaManual",
      pg."rowId" AS "pagoRef"
    FROM base b
    JOIN gestion_pagos pg ON pg.business_id = b.biz_compra AND pg.branch_id IS NOT DISTINCT FROM b.suc_compra AND pg.comprobante = b.comp AND pg."codPro" = b.codigo
      AND pg."fechaPago" IS NOT NULL AND pg.importe IS NOT NULL
    WHERE NOT b.es_gv
    UNION ALL
    -- Pagos cargados en Lazarillo (Etapa 4): una fila por imputación, por la parte que
    -- cubre. El mismo pago que ya trae el 80 (importe ±1 peso, fecha ±10 días) no se repite.
    SELECT ${COLS("b")},
      COALESCE(b."importeManual", b.importe) * a.importe
        / COALESCE(NULLIF((
            SELECT MAX(x.total) FROM gestion_pagos x
            WHERE x.business_id = b.biz_compra AND x.branch_id IS NOT DISTINCT FROM b.suc_compra AND x.comprobante = b.comp AND x."codPro" = b.codigo
          ), 0), NULLIF((
            SELECT SUM(COALESCE(x."importeManual", x.importe)) FROM gestion_compras x
            WHERE x.business_id = b.biz_compra AND x.branch_id IS NOT DISTINCT FROM b.suc_compra AND x.comprobante = b.comp AND x.codigo = b.codigo
          ), 0))  AS importe,
      NULL::numeric AS "importeManual",
      pp.fecha::timestamp(3) AS fecha, NULL::timestamp(3) AS "fechaManual",
      ('lz:' || a.id)::text AS "pagoRef"
    FROM base b
    JOIN gestion_aplicaciones_pago_proveedor a ON a.business_id = b.biz_compra AND a.branch_id IS NOT DISTINCT FROM b.suc_compra AND a.comprobante = b.comp AND a."codPro" = b.codigo
    JOIN gestion_pagos_proveedor pp ON pp.id = a."pagoId" AND pp."anuladoEn" IS NULL
    WHERE NOT b.es_gv
      AND NOT EXISTS (
        SELECT 1 FROM gestion_pagos pg
        WHERE pg.business_id = b.biz_compra AND pg.branch_id IS NOT DISTINCT FROM b.suc_compra AND pg.comprobante = b.comp AND pg."codPro" = b.codigo
          AND pg."fechaPago" IS NOT NULL AND ABS(pg.importe - a.importe) <= 1 AND ABS(pg."fechaPago"::date - pp.fecha) <= 10
      )
    UNION ALL
    -- Sin pagos en el 80 ni en Lazarillo pero cuentan en su fecha (NC, pago automático, antes de la cobertura).
    SELECT ${COLS("b")},
      b.importe, b."importeManual",
      b.fecha, b."fechaManual",
      NULL::text AS "pagoRef"
    FROM base b
    WHERE NOT b.es_gv
      AND NOT EXISTS (
        SELECT 1 FROM gestion_pagos pg
        WHERE pg.business_id = b.biz_compra AND pg.branch_id IS NOT DISTINCT FROM b.suc_compra AND pg.comprobante = b.comp AND pg."codPro" = b.codigo
          AND pg."fechaPago" IS NOT NULL AND pg.importe IS NOT NULL
      )
      AND NOT EXISTS (
        SELECT 1 FROM gestion_aplicaciones_pago_proveedor a JOIN gestion_pagos_proveedor pp ON pp.id = a."pagoId" AND pp."anuladoEn" IS NULL
        WHERE a.business_id = b.biz_compra AND a.branch_id IS NOT DISTINCT FROM b.suc_compra AND a.comprobante = b.comp AND a."codPro" = b.codigo
      )
      AND (UPPER(LEFT(b.comp, 1)) = 'N' OR b.auto OR COALESCE(b."fechaManual", b.fecha) < ${desde}::date)
  )`;
}

module.exports = { esModoPanel, fuenteCompras };
