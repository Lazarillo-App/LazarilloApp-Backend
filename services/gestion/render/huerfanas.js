// Portado de lazarillo_gestion/lib/render/huerfanas.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { sql, db } = require('../db');
const { computeCompraRowId, compraIdentityFromRawRow } = require('../etl/normalizers/compra-identity');
const { excelDateToISO } = require('../etl/helpers');
const { filaDeRender } = require('./filas');
const { leerTabla } = require('./db');

// Compras que MaxiRest ya no tiene (Diego 28/10/2026, "cargada dos veces" de ARCA):
// cuando en MaxiRest se edita un gasto (importe de un ticket, concepto, observación, tipo de
// comprobante) cambia su identidad; el Panel traía la versión nueva y dejaba la vieja, así
// que el gasto quedaba contado dos veces (Bar jul–sep 2026: ~20 filas, $6,9 M).
//
// Render tiene la foto COMPLETA del 14 de cada PDV (año actual y anterior). Toda compra de
// MaxiRest (origen null) del Panel cuya identidad no está en esa foto es una versión vieja:
// se pone en $0 con la nota "MaxiRest ya no la tiene" (no se borra) y se guarda lo que tenía
// para devolverlo si la fila reaparece en MaxiRest.
//
// Cuidados: solo desde HUERFANAS_DESDE (antes, MaxiRest del Bar no tiene todo lo que trajo el
// Drive: sueldos de 2025 que no están) y nunca más del TOPE_MES de las filas de un mes (si
// faltara medio mes en Render sería un problema de la foto, no huérfanas): ese mes se saltea.

const HUERFANAS_DESDE = "2026-01-01";
const TOPE_MES = 0.05;
const TOPE_MINIMO = 3;
// Diego (28/10/2026, caso Get Clean: fila editada en MaxiRest contada dos veces): "en esos casos
// quiero que la reemplaces automáticamente y listo" → se aplica sola (la vieja a $0, restaurable).
const APLICAR_HUERFANAS = true;

const NOTA_HUERFANA = "MaxiRest ya no la tiene";

/** Identidades (rowId) de todo lo que tiene Render para el PDV, en sus tablas del 14. */
async function rowIdsEnRender(esquema, tablas, pdv) {
  const ids = new Set();
  const porMes = new Map();
  for (const tabla of tablas) {
    const { filas, tipos } = await leerTabla(esquema, tabla, pdv, false);
    for (const f of filas) {
      const r = filaDeRender(f, tipos);
      ids.add(computeCompraRowId(compraIdentityFromRawRow(r)));
      const iso = excelDateToISO(r["FECHA"]);
      if (iso) porMes.set(iso.slice(0, 7), (porMes.get(iso.slice(0, 7)) ?? 0) + 1);
    }
  }
  return { ids, porMes };
}

/** Elige qué filas del Panel son huérfanas, mes por mes, con el tope de seguridad. Puro. */
function elegirHuerfanas(panel, enRender, desdeMes) {
  const porMes = new Map();
  for (const p of panel) {
    if (p.mes < desdeMes) continue;
    const m = porMes.get(p.mes) ?? { total: 0, huerfanas: [] };
    m.total++;
    if (!enRender.has(p.rowId)) m.huerfanas.push(p.rowId);
    porMes.set(p.mes, m);
  }
  const elegidas = [];
  const salteados = [];
  for (const [mes, m] of [...porMes].sort()) {
    if (!m.huerfanas.length) continue;
    if (m.huerfanas.length > Math.max(TOPE_MINIMO, m.total * TOPE_MES)) { salteados.push(`${mes} (${m.huerfanas.length} de ${m.total})`); continue; }
    elegidas.push(...m.huerfanas);
  }
  return { elegidas, salteados };
}

// o: { esquema, pdv, tablas, businessId, branchId } — el PDV de gestion es negocio + sucursal.
async function revisarHuerfanas(o) {
  const enPdv = sql`business_id = ${o.businessId} AND branch_id IS NOT DISTINCT FROM ${o.branchId ?? null}::bigint`;
  const { ids } = await rowIdsEnRender(o.esquema, o.tablas, o.pdv);
  if (ids.size === 0) return { marcadas: 0, restauradas: 0, mesesSalteados: [] };

  // 1) Restaurar las que volvieron a aparecer en MaxiRest.
  const todas = await db.many(sql`
    SELECT "rowId", estado, motivo, "importeManualAntes", "observacManualAntes" FROM gestion_compras_huerfanas
    WHERE ${enPdv} AND estado IN ('propuesta', 'aplicada')`);
  // Solo se restauran solas las de este motivo (un duplicado anulado desde ARCA sigue en MaxiRest a propósito).
  const previas = todas.filter((x) => x.motivo === "maxirest_ya_no");
  let restauradas = 0;
  for (const p of previas.filter((x) => ids.has(x.rowId))) {
    await db.transaction(async (tx) => {
      if (p.estado === "aplicada") {
        await tx.execute(sql`UPDATE gestion_compras SET "importeManual" = ${p.importeManualAntes}, "observacManual" = ${p.observacManualAntes} WHERE business_id = ${o.businessId} AND "rowId" = ${p.rowId}`);
      }
      await tx.execute(sql`UPDATE gestion_compras_huerfanas SET estado = 'restaurada', "actualizadaEn" = now() WHERE business_id = ${o.businessId} AND "rowId" = ${p.rowId}`);
    });
    restauradas++;
  }

  // 2) Las de MaxiRest que Render no tiene, desde HUERFANAS_DESDE.
  const panel = await db.many(sql`
    SELECT "rowId", fecha, "importeManual", "observacManual", to_char(fecha, 'YYYY-MM') AS mes
    FROM gestion_compras
    WHERE ${enPdv} AND origen IS NULL AND fecha >= ${HUERFANAS_DESDE}::date`);
  // Ya hechas: las aplicadas (y, mientras solo se detecta, las propuestas).
  const yaMarcadas = new Set(todas.filter((x) => x.estado === "aplicada" || (!APLICAR_HUERFANAS && !ids.has(x.rowId))).map((x) => x.rowId));
  const { elegidas, salteados } = elegirHuerfanas(panel, ids, HUERFANAS_DESDE.slice(0, 7));
  const nuevas = elegidas.filter((id) => !yaMarcadas.has(id));
  const estado = APLICAR_HUERFANAS ? "aplicada" : "propuesta";
  for (const rowId of nuevas) {
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        INSERT INTO gestion_compras_huerfanas (business_id, branch_id, "rowId", fecha, comprobante, codigo, proveedor, concepto, importe,
                                       "importeManualAntes", "observacManualAntes", motivo, estado)
        SELECT business_id, branch_id, "rowId", fecha::date, comprobante, codigo, proveedor, concepto, importe,
               "importeManual", "observacManual", 'maxirest_ya_no', ${estado}
        FROM gestion_compras WHERE business_id = ${o.businessId} AND "rowId" = ${rowId}
        ON CONFLICT (business_id, "rowId") DO UPDATE SET estado = EXCLUDED.estado, "importeManualAntes" = EXCLUDED."importeManualAntes",
          "observacManualAntes" = EXCLUDED."observacManualAntes", "actualizadaEn" = now()
        WHERE gestion_compras_huerfanas.estado <> 'aplicada'`);
      if (APLICAR_HUERFANAS) {
        await tx.execute(sql`
          UPDATE gestion_compras SET "importeManual" = 0,
            -- Una fila que ya traía la nota (p. ej. migrada de gestion) no la repite.
            "observacManual" = CASE WHEN COALESCE("observacManual", observac, '') LIKE ${NOTA_HUERFANA + '%'}
              THEN COALESCE("observacManual", observac)
              ELSE ${NOTA_HUERFANA} || COALESCE(' · ' || COALESCE("observacManual", observac), '') END
          WHERE business_id = ${o.businessId} AND "rowId" = ${rowId}`);
      }
    });
  }
  if (salteados.length) console.warn("[huerfanas] meses salteados", o.pdv, salteados);
  return { marcadas: nuevas.length, restauradas, mesesSalteados: salteados };
}

module.exports = { HUERFANAS_DESDE, APLICAR_HUERFANAS, NOTA_HUERFANA, rowIdsEnRender, elegirHuerfanas, revisarHuerfanas };
