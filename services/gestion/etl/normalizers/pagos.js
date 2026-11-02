// Portado de lazarillo_gestion/lib/etl/normalizers/pagos.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { createHash } = require('crypto');
const { sql } = require('../../db');

const { trim, toDecimalStr, excelDateToISO, filaCruda } = require('../helpers');
const { pagoRowSchema } = require('../schemas/pagos');
const { formatZodError } = require('../schemas/common');
const { insertChunkWithRowFallback } = require('../chunked-upsert');
const { resolveProveedorId } = require('./proveedor-match');

// Informe 80 de MaxiRest: una fila por pago aplicado a un comprobante.
//
// Identidad de la fila: el ERP no exporta un id de pago. La clave estable es
// (FECHA_PAGO, ORDEN, comprobante, COD_PRO, IMPORTE, PAGO, COD_CGA) + una
// secuencia para las filas idénticas — caso real: cuotas iguales de una misma
// orden de pago (6 × $750.000 en la misma orden y fecha suman el total del
// comprobante). La secuencia sigue el orden del archivo, así que un reimport
// del mismo archivo pisa las mismas filas en vez de duplicarlas.
//
// El vínculo con compras es lógico, por (local, PDV, comprobante, codPro):
// un comprobante del 14 puede estar partido en varias filas (concepto +
// percepciones), por eso el pago se cuelga del comprobante y no de una fila.

const CHUNK_SIZE = 500;

// Mismo formato que compras.comprobante / detalle_compras.comprobante:
// COD_CPB + PREFIJO(4) + NUMERO(8). "Tic" no aparece en el 80 (ya viene como Z).
function makeComprobantePago(codCpb, prefijo, numero) {
  const cpb = String(codCpb ?? "").trim().toUpperCase();
  if (!cpb) return null;
  const p = String(prefijo ?? "").trim();
  const n = String(numero ?? "").trim();
  return cpb + p.padStart(4, "0") + n.padStart(8, "0");
}

// "0" y vacío significan "no aplica" en las columnas de código del 80.
function codigoONull(v) {
  const s = trim(v);
  if (s == null || s === "0") return null;
  return s;
}

function claveIdentidadPago(r) {
  return [
    excelDateToISO(r["FECHA_PAGO"]) ?? String(r["FECHA_PAGO"] ?? ""),
    trim(r["ORDEN"]) ?? "",
    makeComprobantePago(r["COD_CPB"], r["PREFIJO"], r["NUMERO"]) ?? "",
    trim(r["COD_PRO"]) ?? "",
    toDecimalStr(r["IMPORTE"]) ?? "",
    (trim(r["PAGO"]) ?? "").toUpperCase(),
    codigoONull(r["COD_CGA"]) ?? "",
  ].join("|");
}

function makePagoRowId(clave, secuencia) {
  return createHash("sha256").update(`${clave}#${secuencia}`).digest("hex").substring(0, 24);
}

function formatFecha(val) {
  const iso = excelDateToISO(val);
  if (!iso) return undefined;
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

async function normalizePagos(
  rows,
  db,
  ctx
) {
  const organizationId = ctx?.organizationId;
  if (ctx?.businessId == null || organizationId == null) throw new Error("normalizePagos: falta businessId/organizationId en el contexto");
  const businessId = ctx.businessId;
  const branchId = ctx.branchId ?? null;
  const skippedRows = [];
  const errors = [];

  const parsedRows = [];
  const vistas = new Map();

  rows.forEach((r, idx) => {
    if (trim(r["COD_CPB"]) == null || trim(r["FECHA_PAGO"]) == null) {
      skippedRows.push({
        fecha: formatFecha(r["FECHA_PAGO"]) ?? formatFecha(r["FECHA"]),
        concepto: trim(r["NOM_CGA"]) ?? undefined,
        importe: toDecimalStr(r["IMPORTE"]) ?? undefined,
        proveedor: trim(r["NOM_PRO"]) ?? trim(r["COD_PRO"]) ?? undefined,
        motivo: "sin_datos",
        ...filaCruda(r, idx),
      });
      return;
    }
    const parsed = pagoRowSchema.safeParse(r);
    if (!parsed.success) {
      errors.push({ rowIndex: idx, rawCodigo: r["ORDEN"], message: formatZodError(parsed.error), ...filaCruda(r, idx) });
      return;
    }
    const clave = claveIdentidadPago(r);
    const secuencia = (vistas.get(clave) ?? 0) + 1;
    vistas.set(clave, secuencia);
    parsedRows.push({ rowId: makePagoRowId(clave, secuencia), row: r, data: parsed.data, idx, secuencia });
  });

  // Con la secuencia no hay rowId repetido dentro del archivo: las filas
  // idénticas son cuotas legítimas, no duplicados. No hay dedup.
  const skipped = skippedRows.length;

  const codigosProv = [...new Set(parsedRows.map((pr) => pr.data.COD_PRO).filter((v) => v != null))];
  const provMap = new Map(
    (await db.many(sql`
      SELECT id, codigo, nombre, razon FROM gestion_proveedores
       WHERE organization_id = ${organizationId} AND codigo = ANY(${codigosProv})`)).map((p) => [p.codigo, { id: p.id, nombre: p.nombre, razon: p.razon }])
  );

  let created = 0;
  let updated = 0;

  for (let i = 0; i < parsedRows.length; i += CHUNK_SIZE) {
    const chunk = parsedRows.slice(i, i + CHUNK_SIZE);
    const chunkRowIds = chunk.map((pr) => pr.rowId);

    const existingSet = new Set(
      (await db.many(sql`
        SELECT "rowId" FROM gestion_pagos
         WHERE business_id = ${businessId} AND "rowId" = ANY(${chunkRowIds})`)).map((d) => d.rowId)
    );

    const chunkErrors = await insertChunkWithRowFallback(
      db,
      chunk,
      (rowsToInsert) => {
        const rowValues = rowsToInsert.map(({ rowId, row, data, secuencia }) => {
          const proveedorId = resolveProveedorId(data.COD_PRO, data.NOM_PRO, provMap);
          return sql`(
            ${rowId},
            ${data.FECHA},
            ${data.COD_CPB.toUpperCase()},
            ${data.PREFIJO},
            ${data.NUMERO},
            ${makeComprobantePago(row["COD_CPB"], row["PREFIJO"], row["NUMERO"])},
            ${data.COD_PRO},
            ${data.NOM_PRO},
            ${data.TOTAL}::numeric,
            ${codigoONull(row["COD_CGA"])},
            ${data.NOM_CGA},
            ${data.PAGO},
            ${data.IMPORTE}::numeric,
            ${data.FECHA_PAGO},
            ${data.ORDEN},
            ${secuencia}::integer,
            ${data.FECHA_VAL},
            ${codigoONull(row["NUMERO_VAL"])},
            ${codigoONull(row["COD_BAN"])},
            ${data.NOM_BAN},
            ${data.IMP_VAL}::numeric,
            ${proveedorId}::integer,
            ${businessId}::bigint,
            ${branchId}::bigint
          )`;
        });

        return sql`
          INSERT INTO gestion_pagos (
            "rowId", fecha, "codCpb", prefijo, numero, comprobante, "codPro", proveedor, total,
            "codCga", concepto, medio, importe, "fechaPago", orden, secuencia,
            "fechaVal", "numeroVal", "codBan", banco, "impVal",
            "proveedorId", business_id, branch_id
          )
          VALUES ${sql.join(rowValues)}
          ON CONFLICT (business_id, "rowId") DO UPDATE SET
            fecha            = EXCLUDED.fecha,
            "codCpb"         = EXCLUDED."codCpb",
            prefijo          = EXCLUDED.prefijo,
            numero           = EXCLUDED.numero,
            comprobante      = EXCLUDED.comprobante,
            "codPro"         = EXCLUDED."codPro",
            proveedor        = EXCLUDED.proveedor,
            total            = EXCLUDED.total,
            "codCga"         = EXCLUDED."codCga",
            concepto         = EXCLUDED.concepto,
            medio            = EXCLUDED.medio,
            importe          = EXCLUDED.importe,
            "fechaPago"      = EXCLUDED."fechaPago",
            orden            = EXCLUDED.orden,
            secuencia        = EXCLUDED.secuencia,
            "fechaVal"       = EXCLUDED."fechaVal",
            "numeroVal"      = EXCLUDED."numeroVal",
            "codBan"         = EXCLUDED."codBan",
            banco            = EXCLUDED.banco,
            "impVal"         = EXCLUDED."impVal",
            "proveedorId"    = EXCLUDED."proveedorId"
            -- branch_id NO se toca (ver gestion_compras en compras.js: en Lazarillo null es
            -- el negocio principal, no "sin asignar").
        `;
      },
      ({ idx, row, data }, err) => ({
        rowIndex: idx,
        rawCodigo: data.ORDEN,
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

  return { created, updated, skipped, skippedRows, errors };
}

module.exports = { makeComprobantePago, codigoONull, claveIdentidadPago, makePagoRowId, normalizePagos };
