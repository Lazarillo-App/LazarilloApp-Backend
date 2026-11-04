// Portado de lazarillo_gestion/lib/dashboard/recortar-has-more.ts (TypeScript → JavaScript, misma lógica).
'use strict';

// La query pide `limite + 1` filas: si vuelve la de más, hay registros que no se muestran. Así el
// truncado se detecta sin un COUNT(*) aparte y nunca pasa en silencio (CLAUDE.md §2).
function recortarConHasMore (rows, limite) {
  if (rows.length <= limite) return { data: rows, hasMore: false };
  return { data: rows.slice(0, limite), hasMore: true };
}

module.exports = { recortarConHasMore };
