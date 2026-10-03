// services/unidades.js
// Fuente única de conversión de unidades. Movido desde insumosController.
// PESO base = gr, VOLUMEN base = ml. Cruce peso↔volumen asume densidad 1.
//
// canonicalUnit/UNIT_ALIASES espejan EXACTAMENTE
// src/componentes/RecetaModal/helpers.js (frontend) — antes esta tabla acá
// solo conocía k/g/l/cc y no sabía que "porcion"/"porciones"/"u" son la misma
// unidad. Eso hacía que propagarCostoInsumo (la única pasada de costo que
// corre SOLA, en cascada, sin que nadie guarde nada a mano) tratara un item
// en "porción" como una unidad desconocida — factor de conversión 1 a ciegas
// — y le pisara un costo_unitario mal calculado a una receta que hasta ese
// momento estaba bien. Con las dos tablas iguales, cascada y guardado manual
// dan el mismo número siempre.
const UNIT_ALIASES = {
  g: 'gr', gr: 'gr', grs: 'gr', gramo: 'gr', gramos: 'gr',
  k: 'kg', kg: 'kg', kgs: 'kg', kilo: 'kg', kilos: 'kg', kilogramo: 'kg', kilogramos: 'kg',
  ml: 'ml', mls: 'ml', cc: 'ml', mililitro: 'ml', mililitros: 'ml',
  l: 'lt', lt: 'lt', lts: 'lt', litro: 'lt', litros: 'lt',
  u: 'u', un: 'u', uni: 'u', unid: 'u', unidad: 'u', unidades: 'u', und: 'u',
  doc: 'u', docena: 'u',
  porcion: 'u', porciones: 'u', 'porción': 'u', 'porciónes': 'u',
  oz: 'oz', onza: 'oz', onzas: 'oz',
  lb: 'lb', libra: 'lb', libras: 'lb',
};
function canonicalUnit(u) {
  const n = String(u || 'u').toLowerCase().trim();
  return UNIT_ALIASES[n] || n;
}

function factorConversion(from, to) {
  // "oz" acá es SIEMPRE onza fluida (volumen) — nunca onza de peso. No va en PESO.
  const PESO  = { gr: 1, kg: 1000, lb: 453.59 };
  const VOLUM = { ml: 1, lt: 1000, oz: 30 };
  const f = canonicalUnit(from), t = canonicalUnit(to);
  if (f === t) return 1;
  if (PESO[f]  !== undefined && PESO[t]  !== undefined) return PESO[f]  / PESO[t];
  if (VOLUM[f] !== undefined && VOLUM[t] !== undefined) return VOLUM[f] / VOLUM[t];
  const baseF = PESO[f] !== undefined ? PESO[f] : VOLUM[f];
  const baseT = PESO[t] !== undefined ? PESO[t] : VOLUM[t];
  if (baseF !== undefined && baseT !== undefined) return baseF / baseT;
  return 1;
}

/**
 * Normaliza cantidad + unidad a un rango legible (1–999), ajustando el costo
 * unitario en forma inversa para que el costo total del item NO cambie.
 * - Peso:   kg ↔ gr    | Volumen: lt ↔ ml
 * - cantidad < 1     → pasa a unidad chica (× 1000)
 * - cantidad >= 1000 → pasa a unidad grande (÷ 1000)
 * - entre 1 y 999    → sin cambios
 * - unidades u/porcion/equivalencias → sin cambios
 * Devuelve { cantidad, unidad, costoUnitario } normalizados.
 */
function normalizarCantidadUnidad(cantidad, unidad, costoUnitario) {
  const cant = Number(cantidad) || 0;
  const costo = Number(costoUnitario) || 0;
  const u = String(unidad || '').toLowerCase().trim();

  // Familias con conversión ×1000
  const CHICA = { gr: 'kg', ml: 'lt' };   // chica → grande
  const GRANDE = { kg: 'gr', lt: 'ml' };  // grande → chica
  // normalizar aliases
  const uNorm = ({ g: 'gr', k: 'kg', l: 'lt', cc: 'ml' }[u]) || u;

  if (cant === 0) return { cantidad: cant, unidad: uNorm, costoUnitario: costo };

  // grande con cantidad < 1 → pasar a chica (×1000 cantidad, ÷1000 costo)
  if (GRANDE[uNorm] && cant < 1) {
    return {
      cantidad: cant * 1000,
      unidad: GRANDE[uNorm],
      costoUnitario: costo / 1000,
    };
  }
  // chica con cantidad >= 1000 → pasar a grande (÷1000 cantidad, ×1000 costo)
  if (CHICA[uNorm] && cant >= 1000) {
    return {
      cantidad: cant / 1000,
      unidad: CHICA[uNorm],
      costoUnitario: costo * 1000,
    };
  }
  // sin cambios
  return { cantidad: cant, unidad: uNorm, costoUnitario: costo };
}

module.exports = { factorConversion, normalizarCantidadUnidad, canonicalUnit };
