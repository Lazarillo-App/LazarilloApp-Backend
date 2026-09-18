// services/unidades.js
// Fuente única de conversión de unidades. Movido desde insumosController.
// PESO base = gr, VOLUMEN base = ml. Cruce peso↔volumen asume densidad 1.

function factorConversion(from, to) {
  const norm = (u) => {
    const n = String(u || 'u').toLowerCase().trim();
    return { k: 'kg', g: 'gr', l: 'lt', cc: 'ml' }[n] || n;
  };
  // "oz" acá es SIEMPRE onza fluida (volumen) — nunca onza de peso. No va en PESO.
  const PESO  = { gr: 1, kg: 1000, lb: 453.59 };
  const VOLUM = { ml: 1, lt: 1000, oz: 30 };
  const f = norm(from), t = norm(to);
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

module.exports = { factorConversion, normalizarCantidadUnidad };
