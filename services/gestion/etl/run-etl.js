// Portado de lazarillo_gestion/lib/etl/run-etl.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { db: dbPorDefecto } = require('../db');
const { getExcelHeaders, readExcelBuffer } = require('./helpers');
const { detectFileType, buildTipoNoIdentificadoMessage } = require('./detect-file-type');
const { normalizeRubrosConceptoCaja } = require('./normalizers/rubros-concepto-caja');
const { normalizeRubrosArticulo } = require('./normalizers/rubros-articulo');
const { normalizeSubrubrosArticulo } = require('./normalizers/subrubros-articulo');
const { normalizeConceptosCaja } = require('./normalizers/conceptos-caja');
const { normalizeArticulos } = require('./normalizers/articulos');
const { normalizeProveedores } = require('./normalizers/proveedores');
const { normalizeCompras } = require('./normalizers/compras');
const { normalizeDetalleCompras } = require('./normalizers/detalle-compras');
const { normalizeVentas } = require('./normalizers/ventas');
const { normalizePagos } = require('./normalizers/pagos');
const { normalizeNomina } = require('./normalizers/nomina');

const NORMALIZERS = {
  rubrosConceptoCaja: normalizeRubrosConceptoCaja,
  rubrosArticulo:     normalizeRubrosArticulo,
  subrubrosArticulo:  normalizeSubrubrosArticulo,
  conceptosCaja:      normalizeConceptosCaja,
  articulos:          normalizeArticulos,
  proveedores:        normalizeProveedores,
  compras:            normalizeCompras,
  detalleCompras:     normalizeDetalleCompras,
  pagos:              normalizePagos,
  nomina:             normalizeNomina,
  ventas:             normalizeVentas,
};

async function runETL(
  buffer,
  storagePath,
  ctx,
  db
) {
  const startMs = Date.now();

  const headers = getExcelHeaders(buffer);
  const fileType = detectFileType(headers);

  if (!fileType) {
    throw new Error(buildTipoNoIdentificadoMessage(headers));
  }

  const rows = readExcelBuffer(buffer);
  const normalizer = NORMALIZERS[fileType];
  if (!normalizer)
    throw new Error(`No hay normalizer registrado para el tipo de archivo: ${fileType}`);
  const client = db ?? dbPorDefecto;
  const {
    created, updated, skipped, skippedRows, errors,
    comprasDistribuidasModificadas, comprasReconciliadas, reconciliacionesAmbiguas, ventasQuitadas,
  } = await normalizer(rows, client, ctx);

  return {
    fileType,
    totalRows: rows.length,
    created,
    updated,
    skipped,
    skippedRows,
    errors,
    comprasDistribuidasModificadas,
    comprasReconciliadas,
    reconciliacionesAmbiguas,
    ventasQuitadas,
    durationMs: Date.now() - startMs,
    storagePath,
  };
}

// Mismo proceso que runETL pero con las filas ya armadas (sin Excel): lo usa la
// lectura directa desde Render (lib/render). Las filas tienen que venir con la
// misma forma que readExcelBuffer (claves en mayúscula, fechas como serial de
// Excel) para que el rowId sea el mismo que al importar el archivo.
async function runETLFilas(
  fileType,
  rows,
  ctx,
  db
) {
  const startMs = Date.now();
  const normalizer = NORMALIZERS[fileType];
  if (!normalizer) throw new Error(`No hay normalizer registrado para el tipo de archivo: ${fileType}`);
  const {
    created, updated, skipped, skippedRows, errors,
    comprasDistribuidasModificadas, comprasReconciliadas, reconciliacionesAmbiguas, ventasQuitadas,
  } = await normalizer(rows, db, ctx);
  return {
    fileType,
    totalRows: rows.length,
    created,
    updated,
    skipped,
    skippedRows,
    errors,
    comprasDistribuidasModificadas,
    comprasReconciliadas,
    reconciliacionesAmbiguas,
    ventasQuitadas,
    durationMs: Date.now() - startMs,
  };
}

module.exports = { runETL, runETLFilas };
