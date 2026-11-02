// Portado de lazarillo_gestion/lib/dashboard/observacion-busqueda.ts (TypeScript → JavaScript, misma lógica).
'use strict';

// Tabla única de acentos: la usan el translate() del SQL (columna) y quitarAcentos (lo tipeado),
// así ambos lados se normalizan igual. La ñ queda afuera a propósito: "año" y "ano" son distintas.
// translate() exige que ambas cadenas tengan el mismo largo (reemplazo carácter a carácter).
const ACENTOS_DESDE = "áéíóúüÁÉÍÓÚÜ";
const ACENTOS_HACIA = "aeiouuAEIOUU";

const REEMPLAZOS = new Map([...ACENTOS_DESDE].map((c, i) => [c, ACENTOS_HACIA[i]]));

function quitarAcentos(texto) {
  return [...texto].map((c) => REEMPLAZOS.get(c) ?? c).join("");
}

const MIN_CARACTERES = 2;

// Opción del buscador para filtrar por lo tipeado (contenido parcial), en vez de por la
// observación completa de una compra puntual.
function opcionContiene(tipeado) {
  const query = tipeado.trim();
  if (query.length < MIN_CARACTERES) return null;
  return { query, label: `contiene «${query}»` };
}

module.exports = { ACENTOS_DESDE, ACENTOS_HACIA, quitarAcentos, opcionContiene };
