// Portado de lazarillo_gestion/lib/dashboard/importe-busqueda.ts (TypeScript → JavaScript, misma lógica).
'use strict';

// Búsqueda por importe en el palette (punto 9 de Pendientes_desarrollo_etapa3):
// escribir un número lista los gastos cuyo importe coincide, para rastrear un
// gasto conociendo solo la plata (ej. un movimiento del banco). Puro, sin
// dependencias: lo usa el palette (cliente) y la ruta /api/search/importe.

// Formatos aceptados (es-AR y variantes que se tipean rápido):
//   811980 · 811.980 · 811980,50 · 811.980,50 · 811980.50 · $ 811.980 · -811.980
// Mínimo 3 dígitos en la parte entera para no listar cualquier cosa con "12".
// El signo se ignora: una NC está en negativo en la base pero el movimiento
// del banco que se está rastreando es positivo.
const FORMATO = /^(\d{1,3}(?:\.\d{3})+|\d+)(?:[,.](\d{1,2}))?$/;

function parsearImporte(q) {
  const limpio = q.trim().replace(/^[-$\s]+/, "").replace(/\s+/g, "");
  if (!limpio) return null;
  const m = FORMATO.exec(limpio);
  if (!m) return null;
  const entero = m[1].replace(/\./g, "");
  if (entero.length < 3) return null;
  const centavos = m[2];
  if (centavos === undefined) return { valor: entero, conCentavos: false };
  return { valor: `${entero}.${centavos.padEnd(2, "0")}`, conCentavos: true };
}

module.exports = { parsearImporte };
