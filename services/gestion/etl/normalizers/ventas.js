// Portado de lazarillo_gestion/lib/etl/normalizers/ventas.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { createHash } = require('crypto');
const { sql } = require('../../db');

const { trim, toDecimalStr, excelDateToISO, filaCruda } = require('../helpers');

const { ventaRowSchema } = require('../schemas/ventas');
const { formatZodError } = require('../schemas/common');
const { insertChunkWithRowFallback } = require('../chunked-upsert');
const { esManual } = require('../../ventas-manuales/carga');

// Filas por chunk de INSERT ... ON CONFLICT.
// 500 → 2000 (22/10/2026): el 22 de Comercio 2025 trae 40.886 filas y con
// lotes de 500 son ~164 idas y vueltas a la base (findMany + upsert por lote);
// con la latencia Vercel↔Supabase cortaba a los 60 s con 38.000 cargadas.
// 23 parámetros por fila × 2000 = 46.000, debajo del tope de 65.535 de Postgres.
const CHUNK_SIZE = 2000;

// makeRowId opera sobre la fila ya "rellenada" por fillPartialRows (igual que el
// comportamiento original) pero nunca sobre datos coercionados por Zod — el hash
// tiene que ser estable entre reimports del mismo archivo.
// `vez`: la 2ª, 3ª… vez que la MISMA fila aparece en el archivo (dos cobros idénticos en un ticket,
// que MaxiRest lista dos veces de verdad). Antes daban el mismo rowId y se guardaba una sola
// (Diego 29/10/2026: faltaban $87.157 en 4 meses de Comercio). La 1ª vez da el rowId de siempre.
function makeRowId(r, vez = 1) {
  // FECHA incluida para evitar colisiones entre transacciones sin TURNO/COMPROBANT
  // (ventas de cancha sin turno asignado): distintos días con mismo COBRO/IMPORTE
  // colisionaban y se perdían. Secondary rows (FECHA=null) pueden colidir entre sí,
  // pero el dashboard los excluye con WHERE fecha IS NOT NULL.
  const key = [r["TURNO"], r["COMPROBANT"], r["COD_COBRO"], r["COBRO"], r["IMPORTE"], r["CUPON"], r["FECHA"]]
    .map((v) => String(v ?? ""))
    .join("|");
  return createHash("sha256").update(vez > 1 ? `${key}#${vez}` : key).digest("hex").substring(0, 24);
}

/** Clave de la venta con los valores ya normalizados (los mismos que quedan en la base). */
function claveLogica(v) {
  const t = (x) => (x == null ? "" : String(x).trim());
  const imp = v.importe == null || String(v.importe).trim() === "" ? "" : Number(String(v.importe)).toFixed(2);
  const f = v.fecha == null ? "" : (v.fecha instanceof Date ? v.fecha.toISOString() : String(v.fecha)).slice(0, 10);
  return [t(v.turno), t(v.comprobant), t(v.codCobro), t(v.cobro), imp, t(v.cupon), f].join("|");
}

async function reusarRowIdsExistentes(db, filas, pdv) {
  const fechas = filas.map((f) => f.data.FECHA).filter((d) => d instanceof Date && !isNaN(d.getTime()));
  if (!fechas.length) return;
  const ts = fechas.map((d) => d.getTime());
  const desde = new Date(ts.reduce((a, b) => Math.min(a, b)));
  const hasta = new Date(ts.reduce((a, b) => Math.max(a, b)));
  const existentes = await db.many(sql`
    SELECT "rowId", turno, comprobant, "codCobro", cobro, importe, cupon, fecha
      FROM gestion_ventas
     WHERE business_id = ${pdv.businessId} AND branch_id IS NOT DISTINCT FROM ${pdv.branchId}::bigint
       AND fecha >= ${desde} AND fecha <= ${hasta}`);
  if (!existentes?.length) return;
  // Las cargadas a mano en el Panel ("man-…") no son de MaxiRest: nunca se reusan.
  const deMaxiRest = existentes.filter((e) => !esManual(e.rowId));
  const idsExistentes = new Set(existentes.map((e) => e.rowId));
  const enArchivo = new Set(filas.map((f) => f.rowId));
  // Por clave, los rowId que hay en la base y que este archivo no trae (los que quedarían "colgados").
  const libres = new Map();
  for (const e of deMaxiRest) {
    if (enArchivo.has(e.rowId)) continue;
    const k = claveLogica(e);
    libres.set(k, [...(libres.get(k) ?? []), e.rowId]);
  }
  for (const f of filas) {
    if (idsExistentes.has(f.rowId)) continue;
    const d = f.data;
    const lista = libres.get(claveLogica({ turno: d.TURNO, comprobant: d.COMPROBANT, codCobro: d.COD_COBRO, cobro: d.COBRO, importe: d.IMPORTE, cupon: d.CUPON, fecha: d.FECHA }));
    const id = lista?.shift();
    if (id) f.rowId = id;
  }
}

// Completa TURNO→NOMBRESUC cuando una venta tiene múltiples formas de pago (pago partido).
// El ERP deja esos campos vacíos en las filas secundarias; se heredan de la fila anterior.
// Soporta N formas de cobro consecutivas (el cliente puede pagar con 4, 5 o 6 métodos).
function fillPartialRows(rows) {
  const CARRY_FIELDS = ["TURNO", "COMPROBANT", "HORA", "TIPO", "MESA", "MOZO", "COD_SUC", "NOMBRESUC"];
  const last = {};
  return rows.map((r) => {
    const filled = { ...r };
    for (const f of CARRY_FIELDS) {
      const v = filled[f];
      const empty = v == null || String(v).trim() === "";
      if (!empty) {
        last[f] = v;
      } else if (last[f] != null) {
        filled[f] = last[f];
      }
    }
    return filled;
  });
}

function formatFecha(val) {
  const iso = excelDateToISO(val);
  if (!iso) return undefined;
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

async function normalizeVentas(
  rows,
  db,
  ctx
) {
  // Filtrar primero: eliminar encabezados de fecha/totales del día (TURNO y COD_COBRO ambos vacíos)
  const indiceEnArchivo = new Map(rows.map((r, i) => [r, i]));
  const invalidRows = rows.filter((r) => trim(r["TURNO"]) == null && trim(r["COD_COBRO"]) == null);
  const validRows = rows.filter((r) => !(trim(r["TURNO"]) == null && trim(r["COD_COBRO"]) == null));
  const filled = fillPartialRows(validRows);

  const skippedRows = invalidRows.map((r) => ({
    fecha: formatFecha(r["FECHA"]),
    concepto: trim(r["COBRO"]) ?? undefined,
    importe: toDecimalStr(r["IMPORTE"]) ?? toDecimalStr(r["TOTAL"]) ?? undefined,
    motivo: "sin_datos",
    ...filaCruda(r, indiceEnArchivo.get(r) ?? 0),
  }));
  const errors = [];

  // Fila con TURNO/COD_COBRO presentes pero algún otro campo (ej. IMPORTE con
  // contenido no numérico) que no parsea → errors, no null en silencio.

  const parsedRows = [];
  const vecesVista = new Map();
  filled.forEach((r, idx) => {
    const parsed = ventaRowSchema.safeParse(r);
    if (!parsed.success) {
      errors.push({ rowIndex: idx, rawCodigo: r["COMPROBANT"], message: formatZodError(parsed.error), ...filaCruda(r, idx) });
      return;
    }
    // Solo filas con fecha: las secundarias de pago partido (sin fecha) siguen como antes.
    const base = makeRowId(r);
    const vez = parsed.data.FECHA ? (vecesVista.get(base) ?? 0) + 1 : 1;
    vecesVista.set(base, vez);
    parsedRows.push({ rowId: vez > 1 ? makeRowId(r, vez) : base, row: r, data: parsed.data, idx });
  });

  // Dedup por rowId — last-wins, pero ahora la fila que se pisa se reporta en
  // skippedRows con motivo "duplicado" en vez de perderse en silencio.
  const rowIdMap = new Map();
  for (const pr of parsedRows) {
    const prev = rowIdMap.get(pr.rowId);
    if (prev) {
      skippedRows.push({
        fecha: formatFecha(prev.row["FECHA"]),
        concepto: trim(prev.row["COBRO"]) ?? undefined,
        importe: toDecimalStr(prev.row["IMPORTE"]) ?? toDecimalStr(prev.row["TOTAL"]) ?? undefined,
        motivo: "duplicado",
        ...filaCruda(prev.row, prev.idx),
        original: filaCruda(pr.row, pr.idx),
      });
    }
    rowIdMap.set(pr.rowId, pr);
  }
  const filtered = Array.from(rowIdMap.values());
  const skipped = skippedRows.length;

  // El PDV de gestion es negocio + sucursal en Lazarillo.
  if (ctx?.businessId == null) throw new Error("normalizeVentas: falta businessId en el contexto");
  const businessId = ctx.businessId;
  const branchId = ctx.branchId ?? null;
  const pdv = { businessId, branchId };

  // Nunca duplicar una venta (Diego 29/10/2026): en Comercio había ~20% de filas dobles (todas las
  // facturas U/_/Y, desde 2025) — la misma venta guardada dos veces con rowId distinto, porque el
  // rowId se arma con el texto crudo del Excel y una exportación anterior lo escribía distinto.
  // Antes de insertar, si ya hay en ese PDV una venta con los mismos datos (ya normalizados) y otro
  // rowId, se usa ese rowId: se actualiza en vez de crear otra.
  await reusarRowIdsExistentes(db, filtered, pdv);

  let created = 0;
  let updated = 0;

  for (let i = 0; i < filtered.length; i += CHUNK_SIZE) {
    const chunk = filtered.slice(i, i + CHUNK_SIZE);
    const chunkRowIds = chunk.map((pr) => pr.rowId);

    const existingSet = new Set(
      (await db.many(sql`
        SELECT "rowId" FROM gestion_ventas
         WHERE business_id = ${businessId} AND "rowId" = ANY(${chunkRowIds})`)).map((v) => v.rowId)
    );

    const chunkErrors = await insertChunkWithRowFallback(
      db,
      chunk,
      (rowsToInsert) => {
        const rowValues = rowsToInsert.map(({ rowId, data }) => {
          return sql`(
            ${rowId},
            ${data.TURNO},
            ${data.COMPROBANT},
            ${data.HORA},
            ${data.TIPO},
            ${data.MESA},
            ${data.MOZO},
            ${data.CUB},
            ${data.COBRO},
            ${data.COD_COBRO},
            ${data.IMPORTE}::numeric,
            ${data.IMPORTE}::numeric,
            ${data.TOTAL}::numeric,
            ${data.DESCUENTO}::numeric,
            ${data.CLINOMBRE},
            ${data.CLIRAZON},
            ${data.CLICUIT},
            ${data.FECHA},
            ${data.COD_SUC},
            ${data.NOMBRESUC},
            ${data.CUPON},
            ${businessId}::bigint,
            ${branchId}::bigint
          )`;
        });

        return sql`
          INSERT INTO gestion_ventas (
            "rowId", turno, comprobant, hora, tipo, mesa, mozo, cub, cobro, "codCobro",
            importe, "importeTrabajado", total, descuento, "cliNombre", "cliRazon", "cliCut",
            fecha, "codSuc", "nombreSuc", cupon, business_id, branch_id
          )
          VALUES ${sql.join(rowValues)}
          ON CONFLICT (business_id, "rowId") DO UPDATE SET
            turno             = EXCLUDED.turno,
            comprobant        = EXCLUDED.comprobant,
            hora              = EXCLUDED.hora,
            tipo              = EXCLUDED.tipo,
            mesa              = EXCLUDED.mesa,
            mozo              = EXCLUDED.mozo,
            cub               = EXCLUDED.cub,
            cobro             = EXCLUDED.cobro,
            "codCobro"        = EXCLUDED."codCobro",
            importe           = EXCLUDED.importe,
            -- importeTrabajado: NO se sobreescribe (override manual, igual que compras)
            total             = EXCLUDED.total,
            descuento         = EXCLUDED.descuento,
            "cliNombre"       = EXCLUDED."cliNombre",
            "cliRazon"        = EXCLUDED."cliRazon",
            "cliCut"          = EXCLUDED."cliCut",
            fecha             = EXCLUDED.fecha,
            "codSuc"          = EXCLUDED."codSuc",
            "nombreSuc"       = EXCLUDED."nombreSuc",
            cupon             = EXCLUDED.cupon
            -- branch_id NO se toca (ver gestion_compras en compras.js: en Lazarillo null es
            -- el negocio principal, no "sin asignar").
        `;
      },
      ({ idx, row, data }, err) => ({
        rowIndex: idx,
        rawCodigo: data.COMPROBANT,
        message: err instanceof Error ? err.message : String(err),
        ...filaCruda(row, idx),
      }),
      (insertedRows) => {
        for (const { rowId } of insertedRows) {
          if (existingSet.has(rowId)) updated++; else created++;
        }
      }
    );
    errors.push(...chunkErrors);
  }

  // Ventas que ya no están en MaxiRest (Diego 29/10/2026): el archivo es la verdad para sus
  // días; lo que en la base quedó en ese PDV y esas fechas y no vino (un ticket que se anuló o
  // cambió después de importarlo, o un doble viejo) se quita. Freno: si fueran más de 200 no se
  // toca nada y se avisa — puede ser un archivo cortado. Con errores en el archivo, tampoco.
  let ventasQuitadas = 0;
  if (errors.length === 0) {
    const r = await quitarVentasQueNoVinieron(db, filtered, pdv);
    ventasQuitadas = r.quitadas;
    if (r.aviso) errors.push({ rowIndex: -1, rawCodigo: null, message: r.aviso });
  }

  return { created, updated, skipped, skippedRows, errors, ventasQuitadas };
}

async function quitarVentasQueNoVinieron(db, filas, pdv) {
  const ts = filas.map((f) => f.data.FECHA).filter((d) => d instanceof Date && !isNaN(d.getTime())).map((d) => d.getTime());
  if (!ts.length) return { quitadas: 0 };
  const desde = new Date(ts.reduce((a, b) => Math.min(a, b)));
  const hasta = new Date(ts.reduce((a, b) => Math.max(a, b)));
  const enArchivo = new Set(filas.map((f) => f.rowId));
  const enBase = await db.many(sql`
    SELECT "rowId", "importeManual" FROM gestion_ventas
     WHERE business_id = ${pdv.businessId} AND branch_id IS NOT DISTINCT FROM ${pdv.branchId}::bigint
       AND fecha >= ${desde} AND fecha <= ${hasta}`);
  // Las que tienen un importe corregido a mano en el Panel no se tocan.
  // Las cargadas a mano en el Panel ("man-…") no vienen de MaxiRest: nunca se quitan.
  const sobran = (enBase ?? []).filter((v) => !enArchivo.has(v.rowId) && v.importeManual == null && !esManual(v.rowId)).map((v) => v.rowId);
  if (!sobran.length) return { quitadas: 0 };
  if (sobran.length > 200) {
    return { quitadas: 0, aviso: `Hay ${sobran.length} ventas en el Panel que no están en este archivo (mismos días). Son demasiadas para quitarlas solas: revisá que el archivo esté completo.` };
  }
  await db.execute(sql`DELETE FROM gestion_ventas WHERE business_id = ${pdv.businessId} AND "rowId" = ANY(${sobran})`);
  return { quitadas: sobran.length };
}

module.exports = { makeRowId, claveLogica, fillPartialRows, normalizeVentas };
