// Compras "Sin concepto de caja asociado" (Diego 06/11/2026: "al cuadro económico tiene que
// entrar sí o sí").
//
// En MaxiRest el concepto de caja de un insumo sale de su rubro. Un insumo sin rubro tiene
// concepto 0 y sus renglones de la factura (informe 25) NUNCA llegan a Caja (informe 14):
// verificado en 2026 comprobante por comprobante y concepto por concepto (el 14 de cada
// concepto = la suma de sus renglones del 25; el 14 no tiene filas con concepto 0). Sin esto,
// esa plata no sumaba en Resultados.
//
// Por cada comprobante del PDV con renglones de concepto 0 se arma UNA compra con su suma
// (origen 'sin-concepto', concepto NULL → Sin rubro, texto "Sin concepto de caja asociado").
// - No duplica: el rowId sale del comprobante (uno por comprobante) y se recalcula en cada
//   importación (upsert). Lo que MaxiRest ya manda a Caja no se toca.
// - Si el insumo pasa a tener rubro en MaxiRest, su renglón deja de ser concepto 0: la compra
//   se ajusta o se borra sola (y el renglón entra por Caja como cualquier otro).
// - Lo que se corrija en Lazarillo (concepto, fecha, importe manual) se respeta: el upsert solo
//   pisa lo que viene de MaxiRest.
// - Pago (financiero): el de la fila de Caja del mismo comprobante, si la hay.
// - Solo los tipos de comprobante que MaxiRest pasa a Caja (A, C, Z y notas de crédito «+», que en
//   Caja van como «NC…» y en negativo). N, B y Q no llegan a Caja ni con concepto: no se tocan.
// - Fecha: la de la fila de Caja del mismo comprobante (así queda en el mismo mes que el resto de
//   la factura); si no hay, la del detalle.
// - Desde 2026: antes de sep-2025 el 25 no traía el concepto de cada renglón (no se puede
//   distinguir) y es el mismo corte que las huérfanas.
'use strict';

const { sql, db } = require('../db');

const ORIGEN_SIN_CONCEPTO = 'sin-concepto';
const TEXTO_SIN_CONCEPTO = 'Sin concepto de caja asociado';
const SIN_CONCEPTO_DESDE = '2026-01-01';

const esSinConcepto = (col) => sql`COALESCE(NULLIF(NULLIF(TRIM(${col}), ''), '0'), '0') = '0'`;

/** Recalcula las compras sin concepto de un PDV. Devuelve { altas, cambios, bajas }. */
async function sincronizarSinConcepto(pdv, { tx = db } = {}) {
  const { businessId, branchId = null } = pdv;
  if (businessId == null) return { altas: 0, cambios: 0, bajas: 0 };
  const monto = sql`COALESCE(dc."totalIns", 0) + COALESCE(dc."ivaTot", 0) + COALESCE(dc."impNtTot", 0)`;
  const r = await tx.one(sql`
    WITH d AS (
      SELECT CASE WHEN dc."codCpb" = '+' THEN 'NC' || substr(dc.comprobante, 2) ELSE dc.comprobante END AS comprobante,
             dc."codPro",
             CASE WHEN dc."codCpb" = '+' THEN -1 ELSE 1 END * SUM(${monto}) AS importe,
             CASE WHEN dc."codCpb" = '+' THEN -1 ELSE 1 END * SUM(COALESCE(dc."impNtTot", 0)) AS imp_int,
             MIN(dc.fecha) AS fecha_detalle,
             LEFT(string_agg(DISTINCT TRIM(dc.nombre), ', '), 500) AS insumos
        FROM gestion_detalle_compras dc
       WHERE dc.business_id = ${businessId}
         AND dc.branch_id IS NOT DISTINCT FROM ${branchId}::bigint
         AND dc.origen IS NULL
         AND dc.comprobante IS NOT NULL
         AND dc."codCpb" IN ('A', 'C', 'Z', '+')
         AND dc.fecha >= ${SIN_CONCEPTO_DESDE}::date
         AND ${esSinConcepto(sql`dc."codCga"`)}
       GROUP BY 1, dc."codPro", dc."codCpb"
      HAVING ABS(SUM(${monto})) >= 0.01
    ),
    s AS (
      SELECT 'sc:' || md5(${String(businessId)} || '|' || COALESCE(${branchId}::text, '') || '|' || d.comprobante || '|' || COALESCE(d."codPro", '')) AS "rowId",
             d.*, COALESCE(h.fecha, d.fecha_detalle) AS fecha,
             COALESCE(h.proveedor, TRIM(COALESCE(p.nombre, p.razon))) AS proveedor,
             COALESCE(h."proveedorId", p.id) AS proveedor_id,
             h."fechaPago", h."cajaPago", h."proveedorTextoNormalizado"
        FROM d
        LEFT JOIN LATERAL (
          SELECT c.fecha, c.proveedor, c."fechaPago", c."cajaPago", c."proveedorId", c."proveedorTextoNormalizado"
            FROM gestion_compras c
           WHERE c.business_id = ${businessId}
             AND c.branch_id IS NOT DISTINCT FROM ${branchId}::bigint
             AND c.origen IS NULL AND c.comprobante = d.comprobante AND c.codigo IS NOT DISTINCT FROM d."codPro"
           ORDER BY c."fechaPago" NULLS LAST, c."rowId" LIMIT 1) h ON true
        LEFT JOIN gestion_proveedores p
          ON p.organization_id = (SELECT b.organization_id FROM app_businesses b WHERE b.id = ${businessId})
         AND p.codigo = d."codPro"
    ),
    up AS (
      INSERT INTO gestion_compras (
        business_id, branch_id, "rowId", comprobante, "codCga", concepto, fecha, codigo, proveedor, detalle, observac,
        importe, "importeTrabajado", "impInt", per1, per2, per3, "proveedorId", "conceptoCodigo", "proveedorTextoNormalizado",
        "fechaPago", "cajaPago", "esBloqueado", "esDistribuido", origen)
      SELECT ${businessId}, ${branchId}::bigint, s."rowId", s.comprobante, '0', ${TEXTO_SIN_CONCEPTO}, s.fecha, s."codPro",
             s.proveedor, s.insumos, NULL,
             s.importe, s.importe, s.imp_int, 0, 0, 0, s.proveedor_id, NULL, s."proveedorTextoNormalizado",
             s."fechaPago", s."cajaPago", false, false, ${ORIGEN_SIN_CONCEPTO}
        FROM s
      ON CONFLICT (business_id, "rowId") DO UPDATE SET
        importe = EXCLUDED.importe, "importeTrabajado" = EXCLUDED."importeTrabajado", "impInt" = EXCLUDED."impInt",
        fecha = EXCLUDED.fecha, detalle = EXCLUDED.detalle, proveedor = EXCLUDED.proveedor, "proveedorId" = EXCLUDED."proveedorId",
        "fechaPago" = EXCLUDED."fechaPago", "cajaPago" = EXCLUDED."cajaPago"
      WHERE gestion_compras.origen = ${ORIGEN_SIN_CONCEPTO}
        AND (gestion_compras.importe, gestion_compras.fecha, gestion_compras.detalle, gestion_compras.proveedor,
             gestion_compras."proveedorId", gestion_compras."fechaPago", gestion_compras."cajaPago")
            IS DISTINCT FROM
            (EXCLUDED.importe, EXCLUDED.fecha, EXCLUDED.detalle, EXCLUDED.proveedor,
             EXCLUDED."proveedorId", EXCLUDED."fechaPago", EXCLUDED."cajaPago")
      RETURNING (xmax = 0) AS alta
    ),
    baja AS (
      DELETE FROM gestion_compras c
       WHERE c.business_id = ${businessId}
         AND c.branch_id IS NOT DISTINCT FROM ${branchId}::bigint
         AND c.origen = ${ORIGEN_SIN_CONCEPTO}
         AND NOT EXISTS (SELECT 1 FROM s WHERE s."rowId" = c."rowId")
      RETURNING 1
    )
    SELECT (SELECT COUNT(*) FROM up WHERE alta)::int AS altas,
           (SELECT COUNT(*) FROM up WHERE NOT alta)::int AS cambios,
           (SELECT COUNT(*) FROM baja)::int AS bajas`);
  return r ?? { altas: 0, cambios: 0, bajas: 0 };
}

module.exports = { sincronizarSinConcepto, ORIGEN_SIN_CONCEPTO, TEXTO_SIN_CONCEPTO, SIN_CONCEPTO_DESDE };
