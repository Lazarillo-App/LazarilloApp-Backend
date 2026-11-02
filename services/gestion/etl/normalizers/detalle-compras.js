// Portado de lazarillo_gestion/lib/etl/normalizers/detalle-compras.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { createHash } = require('crypto');
const { sql } = require('../../db');

const { trim, toDecimalStr, excelDateToISO, filaCruda } = require('../helpers');
const { linkDetalleComprasByComprobante } = require('../normalizer-utils');

const { detalleCompraRowSchema } = require('../schemas/detalle-compras');
const { formatZodError } = require('../schemas/common');
const { insertChunkWithRowFallback } = require('../chunked-upsert');
const { comprobantesDeLazarillo, claveSalteo } = require('../../facturas/saltear-lazarillo');

const CHUNK_SIZE = 500;

function makeComprobante(r) {
  const cpb  = String(r["COD_CPB"] ?? "").trim();
  const num1 = String(r["NUMERO1"] ?? "").trim().padStart(4, "0");
  const num2 = String(r["NUMERO2"] ?? "").trim().padStart(8, "0");
  if (!cpb) return null;
  return `${cpb}${num1.padStart(4, "0")}${num2.padStart(8, "0")}`;
}

// makeRowId opera siempre sobre la fila cruda — el hash tiene que ser estable
// entre reimports del mismo archivo.
function makeRowId(r) {
  // El ERP no exporta número de línea — CANTIDAD+NETO son los únicos
  // diferenciadores cuando el mismo artículo aparece dos veces en la misma factura.
  const key = [r["COD_CPB"], r["NUMERO1"], r["NUMERO2"], r["CODIGO"], r["CANTIDAD"], r["NETO"]]
    .map((v) => String(v ?? ""))
    .join("|");
  return createHash("sha256").update(key).digest("hex").substring(0, 24);
}

function formatFecha(val) {
  const iso = excelDateToISO(val);
  if (!iso) return undefined;
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

async function normalizeDetalleCompras(
  rows,
  db,
  ctx
) {
  const organizationId = ctx?.organizationId;
  if (ctx?.businessId == null || organizationId == null) throw new Error("normalizeDetalleCompras: falta businessId/organizationId en el contexto");
  const businessId = ctx.businessId;
  const branchId = ctx.branchId ?? null;
  const skippedRows = [];
  const errors = [];

  const parsedRows = [];

  rows.forEach((r, idx) => {
    if (trim(r["COD_CPB"]) == null || trim(r["CODIGO"]) == null) {
      skippedRows.push({
        fecha: formatFecha(r["FECHA"]),
        concepto: trim(r["CODIGO"]) ?? trim(r["NOMBRE"]) ?? undefined,
        importe: toDecimalStr(r["NETO"]) ?? toDecimalStr(r["TOTALINS"]) ?? undefined,
        proveedor: trim(r["COD_PRO"]) ?? undefined,
        motivo: "sin_datos",
        ...filaCruda(r, idx),
      });
      return;
    }
    const parsed = detalleCompraRowSchema.safeParse(r);
    if (!parsed.success) {
      errors.push({ rowIndex: idx, rawCodigo: r["CODIGO"], message: formatZodError(parsed.error), ...filaCruda(r, idx) });
      return;
    }
    parsedRows.push({ rowId: makeRowId(r), row: r, data: parsed.data, idx });
  });

  // Dedup por rowId — last-wins, pero ahora la fila que se pisa se reporta en
  // skippedRows con motivo "duplicado" en vez de perderse en silencio.
  const rowIdMap = new Map();
  for (const pr of parsedRows) {
    const prev = rowIdMap.get(pr.rowId);
    if (prev) {
      skippedRows.push({
        fecha: formatFecha(prev.row["FECHA"]),
        concepto: trim(prev.row["CODIGO"]) ?? trim(prev.row["NOMBRE"]) ?? undefined,
        importe: toDecimalStr(prev.row["NETO"]) ?? toDecimalStr(prev.row["TOTALINS"]) ?? undefined,
        proveedor: trim(prev.row["COD_PRO"]) ?? undefined,
        motivo: "duplicado",
        ...filaCruda(prev.row, prev.idx),
        original: filaCruda(pr.row, pr.idx),
      });
    }
    rowIdMap.set(pr.rowId, pr);
  }
  // Comprobantes ya cargados en Lazarillo: se saltean (gana esa versión, no se duplica).
  const enLazarillo = await comprobantesDeLazarillo(
    db, "detalle", ctx, [...rowIdMap.values()].map((pr) => makeComprobante(pr.row) ?? ""),
  );
  const filtered = Array.from(rowIdMap.values()).filter((pr) => {
    const cpb = makeComprobante(pr.row);
    if (!cpb || !enLazarillo.has(claveSalteo(cpb, pr.data.COD_PRO, excelDateToISO(pr.row["FECHA"])))) return true;
    skippedRows.push({
      fecha: formatFecha(pr.row["FECHA"]),
      concepto: trim(pr.row["CODIGO"]) ?? trim(pr.row["NOMBRE"]) ?? undefined,
      importe: toDecimalStr(pr.row["NETO"]) ?? toDecimalStr(pr.row["TOTALINS"]) ?? undefined,
      proveedor: trim(pr.row["COD_PRO"]) ?? undefined,
      motivo: "cargada_en_lazarillo",
      ...filaCruda(pr.row, pr.idx),
    });
    return false;
  });
  const skipped = skippedRows.length;

  const codigosArt = [...new Set(filtered.map((pr) => pr.data.CODIGO).filter((v) => v != null))];
  const artSet = new Set(
    (await db.many(sql`
      SELECT codigo FROM gestion_articulos
       WHERE organization_id = ${organizationId} AND codigo = ANY(${codigosArt})`)).map((a) => a.codigo)
  );

  let created = 0;
  let updated = 0;

  for (let i = 0; i < filtered.length; i += CHUNK_SIZE) {
    const chunk = filtered.slice(i, i + CHUNK_SIZE);
    const chunkRowIds = chunk.map((pr) => pr.rowId);

    const existingSet = new Set(
      (await db.many(sql`
        SELECT "rowId" FROM gestion_detalle_compras
         WHERE business_id = ${businessId} AND "rowId" = ANY(${chunkRowIds})`)).map((d) => d.rowId)
    );


    const chunkErrors = await insertChunkWithRowFallback(
      db,
      chunk,
      (rowsToInsert) => {
        const rowValues = rowsToInsert.map(({ rowId, row, data }) => {
          const articuloCodigo = artSet.has(data.CODIGO) ? data.CODIGO : null;
          // proveedorId nunca se resuelve acá de forma independiente: esta tabla no
          // tiene un campo de texto de proveedor contra el cual validar el CODIGO
          // (a diferencia de compras.ts) — ver spec 2026-09-19-cruce-proveedorid-compras-design.md §3.3.
          const proveedorId = null;
          return sql`(
            ${rowId},
            ${data.COD_PRO},
            ${data.COD_CPB},
            ${data.NUMERO1},
            ${data.NUMERO2},
            ${makeComprobante(row)},
            ${data.FECHA},
            ${data.CODIGO},
            ${data.NOMBRE},
            ${data.MEDIDA},
            ${data.CANTIDAD}::numeric,
            ${data.NETO}::numeric,
            ${data.TOTALINS}::numeric,
            ${data.IVATOT}::numeric,
            ${data.IMPINTTOT}::numeric,
            ${data.TASA}::numeric,
            ${data.IVA}::numeric,
            ${data.IMP_INT}::numeric,
            ${data.PERCEP}::numeric,
            ${data.OBSERVAC},
            ${articuloCodigo},
            ${proveedorId}::integer,
            ${businessId}::bigint,
            ${branchId}::bigint,
            ${data.COD_CGA ?? null},
            ${data.NOM_CGA ?? null}
          )`;
        });

        return sql`
          INSERT INTO gestion_detalle_compras (
            "rowId", "codPro", "codCpb", numero1, numero2, comprobante, fecha, codigo,
            nombre, medida, cantidad, neto, "totalIns", "ivaTot", "impNtTot", tasa, iva,
            "impInt", percep, observac, "articuloCodigo", "proveedorId", business_id, branch_id, "codCga", "nomCga"
          )
          VALUES ${sql.join(rowValues)}
          ON CONFLICT (business_id, "rowId") DO UPDATE SET
            "codPro"        = EXCLUDED."codPro",
            "codCpb"        = EXCLUDED."codCpb",
            numero1         = EXCLUDED.numero1,
            numero2         = EXCLUDED.numero2,
            comprobante     = EXCLUDED.comprobante,
            fecha           = EXCLUDED.fecha,
            codigo          = EXCLUDED.codigo,
            nombre          = EXCLUDED.nombre,
            medida          = EXCLUDED.medida,
            cantidad        = EXCLUDED.cantidad,
            neto            = EXCLUDED.neto,
            "totalIns"      = EXCLUDED."totalIns",
            "ivaTot"        = EXCLUDED."ivaTot",
            "impNtTot"      = EXCLUDED."impNtTot",
            tasa            = EXCLUDED.tasa,
            iva             = EXCLUDED.iva,
            "impInt"        = EXCLUDED."impInt",
            percep          = EXCLUDED.percep,
            observac        = EXCLUDED.observac,
            "articuloCodigo"= EXCLUDED."articuloCodigo",
            "proveedorId"   = EXCLUDED."proveedorId",
            -- branch_id NO se toca (ver gestion_compras en compras.js: en Lazarillo null es
            -- el negocio principal, no "sin asignar").
            -- COALESCE: un 25 viejo (sin las columnas) no borra el concepto que trajo uno nuevo.
            "codCga"        = COALESCE(EXCLUDED."codCga", gestion_detalle_compras."codCga"),
            "nomCga"        = COALESCE(EXCLUDED."nomCga", gestion_detalle_compras."nomCga")
        `;
      },
      ({ idx, row, data }, err) => ({
        rowIndex: idx,
        rawCodigo: data.CODIGO,
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

  if (created > 0 || updated > 0) {
    await linkDetalleComprasByComprobante(db, { businessId, branchId });
  }

  return { created, updated, skipped, skippedRows, errors };
}

module.exports = { makeRowId, normalizeDetalleCompras };
