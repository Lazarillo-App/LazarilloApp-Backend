// Portado de lazarillo_gestion/lib/text-normalize.ts (TypeScript → JavaScript, misma lógica).
'use strict';

// Normaliza texto para comparaciones tolerantes a mayúsculas, tildes y
// puntuación — NFD + strip de marcas combinantes antes de descartar lo
// no-alfanumérico (si no, "Agustín" perdería la "í" entera y dejaría de
// coincidir con "Agustin"). Usado tanto por el ETL (lib/etl/normalizers/
// proveedor-match.ts, para no confiar en un código de proveedor que coincide
// por azar con un código real) como por el dashboard (lib/dashboard/
// pivot-por-proveedor.ts, lib/dashboard/apertura-composicion.ts, para agrupar
// compras sin proveedor real por su texto crudo del ERP) — un solo criterio
// de comparación en ambas capas.
function normalizarTexto(s) {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

// Fallback compartido por ETL, reevaluación de Apertura y el backfill de
// producción — las 3 rutas que necesitan resolver "qué texto de proveedor usar
// cuando no hay proveedorId real", con el mismo criterio que el COALESCE(...,
// 'Sin Proveedor') que ya arma app/api/dashboard/pivot/route.ts.
function normalizarProveedorTexto(proveedor) {
  return normalizarTexto(proveedor ?? "Sin Proveedor");
}

module.exports = { normalizarTexto, normalizarProveedorTexto };
