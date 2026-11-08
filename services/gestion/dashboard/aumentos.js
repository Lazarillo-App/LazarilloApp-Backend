// Portado de lazarillo_gestion/lib/dashboard/aumentos.ts (TypeScript → JavaScript, misma lógica).
// Solo la parte que usa la detección (services/gestion/render/aumentos.js); la comparación con la
// Canasta (aumentosVsCostos, alcanceAumento) vive en el Front (src/gestion/aumentos.js).
'use strict';

// Aumentos de precios de la carta (Diego 30/10/2026): se detectan del informe 12 (ventas por
// artículo por día) y se comparan con la Canasta para ver la BRECHA de cada aumento.

const GRUPOS = ['comidas', 'bebidas', 'promos'];

// Agrupación de la carta según el rubro del artículo en MaxiRest. Los mismos patrones se usan en SQL
// (render/aumentos.js) con ~*, así que tienen que ser regex válidas en JS y en Postgres.
const PATRON_PROMOS = 'promo';
const PATRON_BEBIDAS = '(cerveza|bebida|trago|limonada|mocktail|cafeter|vino|gaseosa|jugo|aperitiv|espumante)';

function grupoDeRubro(rubro) {
  const r = rubro ?? '';
  if (new RegExp(PATRON_PROMOS, 'i').test(r)) return 'promos';
  if (new RegExp(PATRON_BEBIDAS, 'i').test(r)) return 'bebidas';
  return 'comidas';
}

// Fuera de un aumento, en esa ventana sube menos de la mitad de los artículos de una agrupación y su
// precio se mueve menos de 3%. Calibrado con el Bar (sep-25 a oct-26): marca 29/09, 01/12, 30/03,
// 15/06, 24/08 y 19/10, y nada más.
const UMBRAL_SUBEN = 0.5;
const UMBRAL_VARIACION = 0.03;
const MIN_ARTICULOS = 15;

/** v: { semana, grupo, n, suben, variacion } — una agrupación en una semana. */
function marcaAumento(v) {
  return v.n >= MIN_ARTICULOS && v.suben >= UMBRAL_SUBEN && v.variacion >= UMBRAL_VARIACION;
}

/**
 * Semanas de aumento. La ventana de 5 semanas marca también las vecinas: las semanas marcadas seguidas
 * son UN aumento, y su fecha es la semana en que más artículos subieron contra la anterior.
 */
function detectarSemanas(ventanas, subenSemanal) {
  const marcadas = [...new Set(ventanas.filter(marcaAumento).map((v) => v.semana))].sort();
  const grupos = [];
  for (const w of marcadas) {
    const ult = grupos[grupos.length - 1];
    if (ult && dias(ult[ult.length - 1], w) <= 7) ult.push(w); else grupos.push([w]);
  }
  return grupos.map((g) => g.reduce((mejor, w) => ((subenSemanal.get(w) ?? 0) > (subenSemanal.get(mejor) ?? 0) ? w : mejor), g[0]));
}

function dias(a, b) {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

module.exports = { GRUPOS, PATRON_PROMOS, PATRON_BEBIDAS, grupoDeRubro, marcaAumento, detectarSemanas, dias };
