// Portado de lazarillo_gestion/lib/etl/normalizers/proveedor-match.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { normalizarTexto } = require('../../text-normalize');

// Compara el texto crudo de proveedor de una fila del ERP contra el nombre/razón
// de un proveedor candidato del maestro, normalizando ambos (minúsculas, sin
// signos de puntuación) antes de comparar. Evita confiar ciegamente en un CODIGO
// que coincide por azar con el código de un proveedor real cuando el CODIGO en
// realidad identifica otra cosa (empleado de planilla, "GASTOS VARIOS", etc.) —
// ver docs/superpowers/specs/2026-09-19-cruce-proveedorid-compras-design.md.
//
// Asimetría intencional: sin texto para comparar (null), se confía en el código
// (no hay evidencia en contra). Con texto que no matchea ni nombre ni razón, se
// descarta el link — preferible "Sin Proveedor" a una empresa incorrecta.

function proveedorTextoCoincide(
  textoCrudo,
  candidato
) {
  if (textoCrudo == null) return true;
  const t = normalizarTexto(textoCrudo);
  return (
    (candidato.nombre != null && normalizarTexto(candidato.nombre) === t) ||
    (candidato.razon != null && normalizarTexto(candidato.razon) === t)
  );
}

function resolveProveedorId(
  codigoFila,
  textoProveedor,
  provMap
) {
  if (codigoFila == null) return null;
  const candidato = provMap.get(codigoFila);
  if (!candidato) return null;
  return proveedorTextoCoincide(textoProveedor, candidato) ? candidato.id : null;
}

module.exports = { proveedorTextoCoincide, resolveProveedorId };
