// Portado de lazarillo_gestion/lib/impagas/query.ts (TypeScript → JavaScript, misma lógica).
//
// Por ahora solo la fecha de cobertura del informe 80 (la usa dashboard/fuente-compras.js).
// Las consultas de impagas / pagos internos se portan con el módulo de Impagas.
'use strict';

// Desde cuándo se cuentan impagas: antes de esa fecha el informe 80 no cubre
// los comprobantes (en Ramos el 14 de ene–ago 2025 numera las facturas como
// "F" y no cruzan con el 80) y todo aparecería impago. El modal tiene un
// filtro "Desde" (?desde=YYYY-MM-DD); sin él manda IMPAGAS_DESDE o el default.
const IMPAGAS_DESDE_DEFAULT = "2025-09-01";

function impagasDesde(param, env) {
  for (const raw of [param, env]) {
    const v = raw?.trim();
    // Años absurdos (un campo a medio escribir: 0002-…) no valen: traerían todo el historial.
    if (v && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) && Number(v.slice(0, 4)) >= 2015) return v;
  }
  return IMPAGAS_DESDE_DEFAULT;
}

module.exports = { IMPAGAS_DESDE_DEFAULT, impagasDesde };
