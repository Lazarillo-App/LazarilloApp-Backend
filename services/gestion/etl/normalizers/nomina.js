// Portado de lazarillo_gestion/lib/etl/normalizers/nomina.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { sql } = require('../../db');

const { excelDateToISO, filaCruda, trim } = require('../helpers');
const { insertChunkWithRowFallback } = require('../chunked-upsert');

// "000 - nomina" del kit: un archivo por PDV con los empleados de MaxiRest
// (columnas en minúscula: pdv, codigo, nombre, apellido, fecha_baja…). Va en la
// carpeta de transaccionales del PDV, igual que el 14: el PDV sale de ahí.

function col(r, nombre) {
  for (const k of Object.keys(r)) if (k.trim().toUpperCase() === nombre) return r[k];
  return undefined;
}

// "2025-10-31 0:00:00", "2025-10-31" o serial de Excel → "2025-10-31".
function fechaNomina(v) {
  if (typeof v === "number") return excelDateToISO(v);
  const s = trim(v);
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m || Number(m[1]) < 1900) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function filaNomina(r) {
  const codigo = trim(col(r, "CODIGO"));
  if (!codigo) return null;
  return {
    codigo,
    nombre: trim(col(r, "NOMBRE")),
    apellido: trim(col(r, "APELLIDO")),
    fechaBaja: fechaNomina(col(r, "FECHA_BAJA")),
  };
}

async function normalizeNomina(
  rows,
  db,
  ctx
) {
  // El PDV de gestion es negocio + sucursal en Lazarillo.
  const businessId = ctx?.businessId;
  const branchId = ctx?.branchId ?? null;
  if (businessId == null) {
    return {
      created: 0, updated: 0, skipped: 0, skippedRows: [],
      errors: [{ rowIndex: 0, rawCodigo: null, message: "La nómina va en la carpeta de transaccionales de un PDV (no se sabe de qué PDV es)." }],
    };
  }
  const skippedRows = [];
  const filas = [];
  const vistos = new Set();
  rows.forEach((row, idx) => {
    const f = filaNomina(row);
    if (!f) { skippedRows.push({ motivo: "sin_datos", ...filaCruda(row, idx) }); return; }
    if (vistos.has(f.codigo)) { skippedRows.push({ motivo: "duplicado", proveedor: f.codigo, ...filaCruda(row, idx) }); return; }
    vistos.add(f.codigo);
    filas.push({ idx, row, f });
  });

  const existentes = new Set(
    (await db.many(sql`
      SELECT codigo FROM gestion_empleados
       WHERE business_id = ${businessId} AND branch_id IS NOT DISTINCT FROM ${branchId}::bigint`)).map((e) => e.codigo)
  );
  let created = 0;
  let updated = 0;
  const errors = [];
  for (let i = 0; i < filas.length; i += 500) {
    const chunk = filas.slice(i, i + 500);
    errors.push(...await insertChunkWithRowFallback(
      db,
      chunk,
      (rs) => sql`
        INSERT INTO gestion_empleados (business_id, branch_id, codigo, nombre, apellido, "fechaBaja", "actualizadoEn")
        VALUES ${sql.join(rs.map(({ f }) => sql`(${businessId}::bigint, ${branchId}::bigint, ${f.codigo}, ${f.nombre}, ${f.apellido}, ${f.fechaBaja}::date, NOW())`))}
        ON CONFLICT (business_id, branch_id, codigo) DO UPDATE SET
          nombre = EXCLUDED.nombre, apellido = EXCLUDED.apellido,
          "fechaBaja" = EXCLUDED."fechaBaja", "actualizadoEn" = NOW()
      `,
      ({ idx, row, f }, err) => ({ rowIndex: idx, rawCodigo: f.codigo, message: err instanceof Error ? err.message : String(err), ...filaCruda(row, idx) }),
      (ok) => { for (const { f } of ok) { if (existentes.has(f.codigo)) updated++; else created++; } }
    ));
  }
  return { created, updated, skipped: skippedRows.length, skippedRows, errors };
}

module.exports = { fechaNomina, filaNomina, normalizeNomina };
