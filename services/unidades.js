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
  // "p" (porción abreviada) SÍ es un valor real guardado en receta_items.unidad — lo
  // confirman los logs de producción ("no se puede convertir a 'p'", items 'cantidad
  // en porciones' de recetas reales). Había una versión anterior de este alias que se
  // sacó por las dudas, atribuyéndole sin confirmar la corrupción de CHEDDAR PASTA
  // ELABORADO — esa corrupción en realidad era por un item en "gr" (una unidad física,
  // no "p") sin peso equivalente cargado, caso que el guard de "no inventar costo" de
  // más abajo sigue cubriendo igual. "p" en cambio es simplemente "u"/"porción" con
  // otro nombre: no hace falta ningún puente de peso para convertirlo.
  porcion: 'u', porciones: 'u', 'porción': 'u', 'porciónes': 'u', p: 'u',
  // «media porción» (Diego 12/11): solo otro nombre de la unidad de rendimiento.
  media_porcion: 'u', 'media porcion': 'u', 'media porción': 'u', 'medias porciones': 'u',
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

// Tamaño de una unidad (o de una equivalencia del insumo) en su familia: peso en gr, volumen en ml,
// unidades en u. Sirve para comparar cantidades entre unidades (75 gr = 1 «dip y medio» de 75 gr).
const FAMILIA = { gr: ['peso', 1], kg: ['peso', 1000], lb: ['peso', 453.59], ml: ['vol', 1], lt: ['vol', 1000], oz: ['vol', 30], u: ['u', 1] };
function tamanoUnidad(unidad, equivalencias = []) {
  const raw = String(unidad || '').trim().toLowerCase();
  const eq = (equivalencias || []).find((e) => String(e.nombre || '').trim().toLowerCase() === raw);
  if (eq) {
    const base = FAMILIA[canonicalUnit(eq.unidad)];
    return base ? { familia: base[0], valor: (Number(eq.contenido) || 0) * base[1] } : null;
  }
  const base = FAMILIA[canonicalUnit(raw)];
  return base ? { familia: base[0], valor: base[1] } : null;
}

module.exports = { factorConversion, normalizarCantidadUnidad, canonicalUnit, tamanoUnidad };
