// Portado de lazarillo_gestion/lib/etl/normalizer-utils.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { sql } = require('../db');

const BATCH_SIZE = 50;

// Pre-carga los códigos existentes en un Set para O(1) lookup durante upsert.
async function preloadExistingCodes(
  codigos,
  fetcher
) {
  if (codigos.length === 0) return new Set();
  const existing = await fetcher(codigos);
  return new Set(existing.map((x) => x.codigo));
}

// Vincula detalle_compras.compraId por coincidencia de comprobante.
// Se llama al final de normalizeCompras y normalizeDetalleCompras para
// que el orden de importación no afecte el vínculo.
// localId es obligatorio para evitar links cruzados entre locales.
// En Lazarillo el "local" es negocio + sucursal: cada sucursal es otra PC de
// MaxiRest y repite numeraciones (ej. Canchas Ramos y San Justo, ambas del 204).
async function linkDetalleComprasByComprobante(db, { businessId, branchId }) {
  await db.execute(sql`
    UPDATE gestion_detalle_compras dc
    SET "compraId" = c."rowId"
    FROM gestion_compras c
    WHERE dc.comprobante = c.comprobante
      AND dc."compraId" IS NULL
      AND dc.business_id = ${businessId}
      AND c.business_id = ${businessId}
      AND dc.branch_id IS NOT DISTINCT FROM ${branchId}::bigint
      AND c.branch_id IS NOT DISTINCT FROM ${branchId}::bigint
      -- Una línea de MaxiRest nunca a una factura del Panel ni al revés; las del Panel,
      -- además, solo a su mismo proveedor (revisión 27/10/2026).
      AND dc.origen IS NOT DISTINCT FROM c.origen
      AND (dc.origen IS NULL OR dc."codPro" = c.codigo)
  `);
}

// Procesa un array de items en batches concurrentes de BATCH_SIZE.
// Retorna los errores por fila; no aborta el lote ante fallos parciales.
async function processBatch (
  items,
  fn,
  getRawCodigo
) {
  const errors = [];

  for (let b = 0; b < items.length; b += BATCH_SIZE) {
    const batch = items.slice(b, b + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map((item, localIdx) => fn(item, b + localIdx))
    );
    results.forEach((result, localIdx) => {
      if (result.status === "rejected") {
        errors.push({
          rowIndex: b + localIdx,
          rawCodigo: getRawCodigo(batch[localIdx]),
          message:
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason),
        });
      }
    });
  }

  return errors;
}

module.exports = { preloadExistingCodes, linkDetalleComprasByComprobante, processBatch };
