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

module.exports = { mesesHasta, canastaMensual, acumulada, ventanaUltimoAumento, pesoRelativo };
