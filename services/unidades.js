// services/unidades.js
// Fuente única de conversión de unidades. Movido desde insumosController.
// PESO base = gr, VOLUMEN base = ml. Cruce peso↔volumen asume densidad 1.

function factorConversion(from, to) {
  const norm = (u) => {
    const n = String(u || 'u').toLowerCase().trim();
    return { k: 'kg', g: 'gr', l: 'lt', cc: 'ml' }[n] || n;
  };
  const PESO  = { gr: 1, kg: 1000, oz: 28.35, lb: 453.59 };
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

module.exports = { factorConversion };