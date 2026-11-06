// Portado de lazarillo_gestion/lib/dashboard/canasta.ts (TypeScript → JavaScript, misma lógica).
'use strict';

// Canasta = inflación PROPIA de los costos de un PDV (Diego 30/10/2026; metodología en la memoria
// canasta-y-presupuestador). Cuatro componentes, cada uno medido como precio y no como gasto:
//   mercaderías  Laspeyres por insumo del informe 25 (saltos fuera de ×1,5 / ÷1,5 = "a revisar")
//   sueldos      mediana de la variación del MISMO empleado (sin SAC, feriados, adelantos)
//   servicios    mediana de la variación de cada proveedor × concepto (abonos)
//   alquiler     el monto — por ahora EN REVISIÓN: se muestra en gris y no entra al %
// Pesos: lo que pesa cada componente en los gastos de los últimos 6 meses (con aperturas).

/** "YYYY-MM" de los n meses que terminan en anio/mes (el último es el de referencia). */
function mesesHasta(anio, mes, n) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(anio, mes - 1 - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

/** Canasta de cada mes: promedio de las variaciones de los componentes que cuentan, por su peso. */
function canastaMensual(comps, n) {
  return Array.from({ length: n }, (_, i) => {
    let s = 0, w = 0;
    for (const c of comps) {
      const v = c.variaciones[i];
      if (!c.cuenta || v == null || !(c.peso > 0)) continue;
      s += v * c.peso; w += c.peso;
    }
    return w > 0 ? s / w : null;
  });
}

/** Variación acumulada (compuesta) de los meses desde..hasta inclusive; sin datos = null. */
function acumulada(serie, desde, hasta) {
  let x = 1, alguno = false;
  for (let i = Math.max(0, desde); i <= hasta && i < serie.length; i++) {
    const v = serie[i];
    if (v == null) continue;
    x *= 1 + v; alguno = true;
  }
  return alguno ? x - 1 : null;
}

/**
 * Desde el último aumento: el último con fecha hasta el fin del mes de referencia. Cuenta los meses
 * DESPUÉS del mes del aumento (el aumento ya cubría lo de ese mes). Devuelve también si hubo un
 * aumento posterior al mes de referencia (para mostrar "aumentaste el dd/mm").
 */
function ventanaUltimoAumento(meses, aumentos)

  {
  const ref = meses[meses.length - 1];
  const orden = [...aumentos].sort();
  const base = [...orden].reverse().find((f) => f.slice(0, 7) <= ref) ?? null;
  const posterior = orden.find((f) => f.slice(0, 7) > ref) ?? null;
  if (!base) return { base: null, desdeIdx: null, posterior };
  const idx = meses.findIndex((m) => m > base.slice(0, 7));
  return { base, desdeIdx: idx === -1 ? meses.length : idx, posterior };
}

function pesoRelativo(comps) {
  const tot = comps.filter((c) => c.cuenta).reduce((s, c) => s + Math.max(0, c.peso), 0);
  return new Map(comps.map((c) => [c.clave, c.cuenta && tot > 0 ? Math.max(0, c.peso) / tot : 0]));
}

// Mes de sueldos incompleto (Diego 06/11/2026: Comercio oct-26 con la mitad de los sueldos cargados daba
// -2,3%, "inadmisible, mínimo lo mismo del mes anterior"). Un mes es incompleto si no tiene sueldos o
// tiene menos del UMBRAL de los empleados o del total del último mes completo. Su variación (y la del mes
// siguiente, que se compara contra él) no se mide: se estima con el promedio mensual (geométrico) de los
// últimos VENTANA meses medidos (con menos de MIN_MEDIDOS, 0%), nunca menor que 0. Se marca como estimada.
const UMBRAL_COMPLETO = 0.8;
const VENTANA_ESTIMADO = 6;
const MIN_MEDIDOS = 3;
// "Salta y vuelve" (Diego 06/11/2026: Sueldos "Desde 31/08" daba −7,3% por ago +16,2% / sep −9,5% en
// Comercio): dos meses seguidos que se compensan (horas, variables o algo pagado de más un mes) se
// puentean: los dos llevan la mitad (geométrica) del cambio conjunto, como el SAC en la metodología.
const SALTO = 0.05;
/** Pares consecutivos medidos que se compensan → cada uno con la raíz del cambio conjunto. */
function puentear(variaciones, saltar) {
  const out = [...variaciones];
  const puenteados = variaciones.map(() => false);
  for (let i = 0; i + 1 < out.length; i++) {
    const a = out[i], b = out[i + 1];
    if (a == null || b == null || saltar[i] || saltar[i + 1] || puenteados[i]) continue;
    const conjunto = (1 + a) * (1 + b) - 1;
    if (Math.abs(a) >= SALTO && Math.abs(b) >= SALTO && Math.sign(a) !== Math.sign(b)
        && Math.abs(conjunto) < Math.min(Math.abs(a), Math.abs(b))) {
      const v = Math.sqrt((1 + a) * (1 + b)) - 1;
      out[i] = v; out[i + 1] = v;
      puenteados[i] = true; puenteados[i + 1] = true;
      i++;
    }
  }
  return { variaciones: out, puenteados };
}

/**
 * Serie de sueldos lista para la canasta: 1) los meses a medio cargar no se miden (ver arriba);
 * 2) los saltos que vuelven se puentean; 3) los meses incompletos se estiman; 4) un sueldo nunca baja:
 * cada mes es como mínimo 0% ("mínimo lo mismo del mes anterior", Diego 06/11/2026).
 * stats: un elemento por mes de `meses` ({ n, tot } o null); variaciones: una por mes desde el segundo.
 * Devuelve { variaciones, estimados, puenteados } (mismo largo que variaciones).
 */
function estimarIncompletos(variaciones, stats) {
  const incompleto = new Array(stats.length).fill(false);
  let ref = null; // último mes completo
  for (let k = 0; k < stats.length; k++) {
    const st = stats[k];
    if (ref == null) { if (st && st.n > 0) ref = st; continue; }
    if (!st || st.n < UMBRAL_COMPLETO * ref.n || st.tot < UMBRAL_COMPLETO * ref.tot) incompleto[k] = true;
    else ref = st;
  }
  const afectado = variaciones.map((_, i) => !!(incompleto[i + 1] || incompleto[i]));
  const { variaciones: out, puenteados } = puentear(variaciones, afectado);
  const estimados = variaciones.map(() => false);
  for (let i = 0; i < out.length; i++) {
    if (!afectado[i]) continue;
    const previas = [];
    for (let j = i - 1; j >= 0 && previas.length < VENTANA_ESTIMADO; j--) {
      if (!estimados[j] && out[j] != null) previas.push(Math.max(0, out[j]));
    }
    // Con menos de MIN_MEDIDOS meses medidos no hay tendencia confiable: "mínimo lo mismo del mes anterior" (0%).
    out[i] = previas.length >= MIN_MEDIDOS ? Math.exp(previas.reduce((a, v) => a + Math.log(1 + v), 0) / previas.length) - 1 : 0;
    estimados[i] = true;
  }
  return { variaciones: out.map((v) => (v == null ? null : Math.max(0, v))), estimados, puenteados };
}

module.exports = { mesesHasta, canastaMensual, acumulada, ventanaUltimoAumento, pesoRelativo, estimarIncompletos, puentear, UMBRAL_COMPLETO, VENTANA_ESTIMADO };
