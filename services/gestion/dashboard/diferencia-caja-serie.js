// Portado de lazarillo_gestion/lib/dashboard/diferencia-caja-serie.ts (TypeScript → JavaScript, misma lógica).
'use strict';

// Arma la serie mensual continua para Diferencia de caja y corre los dos cálculos derivados de ella:
// el valor "por mes" (principal, spec 2026-09-16) y el acumulado desde el primer arqueo (dato
// secundario de tooltip). Puro: sin fetch, sin Prisma, sin React — testeable con fixtures. La
// orquestación de datos (primer arqueo + sumas SQL) vive en app/api/dashboard/diferencia-caja/route.ts.

const { MONTH_IDXS } = require('./constants');
const { computeDiferenciaCajaAcumulada, computeDiferenciaCajaPorMes } = require('./resultados-calc');

// LÍMITE CONOCIDO (I-3, ver spec 2026-09-09 §1.5 y el fix wave del 24-ago-2026): los agregados
// de compras/ventas arman mapas dispersos — una clave de mes existe solo si hubo filas que
// matchearon. El `?? 0` no distingue "el mes tuvo $0 de verdad" de "no hay dato para este mes"
// (p. ej. import pendiente). Decisión pospuesta explícitamente (2026-09-09), documentada no resuelta.
// Bajo el modelo por mes (spec 2026-09-16): un mes con arqueo pero con un import pendiente/faltante
// calcula su término contable como 0 y muestra un valor que en realidad es solo el delta de
// Disponible (potencialmente engañoso) — pero, a diferencia del modelo acumulado anterior, el error
// queda CONFINADO a la celda de ese mes, no contamina en silencio el acumulado corriente de los
// meses siguientes.
function toSerieDeUnAnio(anio, totals) {
  return MONTH_IDXS.map((mes) => ({
    anio,
    mes,
    ingresos: totals.ingresosPorMes[mes] ?? 0,
    egresos: totals.egresosPorMes[mes] ?? 0,
    ganancia: totals.gananciaPorMes[mes] ?? 0,
    disponible: totals.disponiblePorMes[mes] ?? null,
  }));
}

const ANIO_VACIO = {
  ingresosPorMes: {},
  egresosPorMes: {},
  gananciaPorMes: {},
  disponiblePorMes: {},
};

const MES_VACIO = { valor: null, acumulado: null };

function buildDiferenciaCajaSerie(input

 ) {
  const { year, primerArqueo, totalesPorAnio } = input;

  const vacio = {};
  for (const mes of MONTH_IDXS) vacio[mes] = MES_VACIO;
  if (primerArqueo == null || primerArqueo.anio > year) return vacio;

  const anios = [];
  for (let a = primerArqueo.anio; a <= year; a++) anios.push(a);

  const serie = anios.flatMap((anio) =>
    toSerieDeUnAnio(anio, totalesPorAnio[anio] ?? ANIO_VACIO),
  );
  const porMes = computeDiferenciaCajaPorMes(serie, primerArqueo);
  const acumulado = computeDiferenciaCajaAcumulada(serie, primerArqueo);

  const offset = (year - primerArqueo.anio) * 12;
  const out = {};
  for (const mes of MONTH_IDXS) {
    const i = offset + (mes - 1);
    out[mes] = { valor: porMes[i] ?? null, acumulado: acumulado[i] ?? null };
  }
  return out;
}

module.exports = { buildDiferenciaCajaSerie };
