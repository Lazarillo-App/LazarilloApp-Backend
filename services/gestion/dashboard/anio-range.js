// Portado de lazarillo_gestion/lib/dashboard/anio-range.ts (TypeScript → JavaScript, misma lógica).
'use strict';



/**
 * Deriva el rango de años navegable a partir del mínimo/máximo de fechas ya
 * importadas. El año actual nunca queda fuera del rango, aunque todavía no
 * haya datos cargados para él.
 */
function resolveAnioRange(
  dataMin,
  dataMax,
  currentYear,
) {
  return {
    minYear: dataMin,
    maxYear: Math.max(dataMax ?? currentYear, currentYear),
  };
}

module.exports = { resolveAnioRange };
