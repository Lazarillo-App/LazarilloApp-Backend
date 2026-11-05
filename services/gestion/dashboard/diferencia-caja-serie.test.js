// Portado de lazarillo_gestion/lib/dashboard/diferencia-caja-serie.test.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { describe, it, expect } = require('../test-utils/vitest');
const { buildDiferenciaCajaSerie } = require('./diferencia-caja-serie');

// Helper: arma un TotalesAnio con los mismos números en todos los meses salvo overrides.
function totales(over

   = {}) {
  return {
    ingresosPorMes: over.ingresos ?? {},
    egresosPorMes: over.egresos ?? {},
    gananciaPorMes: over.ganancia ?? {},
    disponiblePorMes: over.disponible ?? {},
  };
}

describe("buildDiferenciaCajaSerie", () => {
  it("sin primer arqueo → los 12 meses en { valor: null, acumulado: null }", () => {
    const out = buildDiferenciaCajaSerie({ year: 2025, primerArqueo: null, totalesPorAnio: {} });
    expect(Object.keys(out)).toHaveLength(12);
    expect(Object.values(out).every((v) => v.valor === null && v.acumulado === null)).toBe(true);
  });

  it("primer arqueo en un año posterior al pedido → los 12 meses vacíos", () => {
    const out = buildDiferenciaCajaSerie({
      year: 2024,
      primerArqueo: { anio: 2025, mes: 3 },
      totalesPorAnio: {},
    });
    expect(Object.values(out).every((v) => v.valor === null && v.acumulado === null)).toBe(true);
  });

  it("un solo año: meses <= primer arqueo vacíos, mes con arqueo posterior con valor y acumulado", () => {
    const out = buildDiferenciaCajaSerie({
      year: 2025,
      primerArqueo: { anio: 2025, mes: 3 },
      totalesPorAnio: {
        2025: totales({
          ingresos: { 3: 100, 4: 120 },
          egresos: { 3: 40, 4: 50 },
          ganancia: { 3: 20, 4: 30 },
          disponible: { 3: 500, 4: 600 },
        }),
      },
    });
    expect(out[1].valor).toBeNull();
    expect(out[2].valor).toBeNull();
    expect(out[3].valor).toBeNull(); // mes del primer arqueo
    // abr: delta = 600 - 500 = 100; contable = (120-50)-30 = 40; valor = 100 - 40 = 60
    expect(out[4].valor).toBe(60);
    expect(out[4].acumulado).toBe(60); // sin huecos previos, valor y acumulado coinciden
    expect(out[5].valor).toBeNull(); // sin datos → sin arqueo → null
  });

  it("cross-año: primer arqueo en 2025, se pide 2026 → recorta al año pedido con el offset correcto", () => {
    const out = buildDiferenciaCajaSerie({
      year: 2026,
      primerArqueo: { anio: 2025, mes: 12 },
      totalesPorAnio: {
        2025: totales({ disponible: { 12: 1000 } }),
        2026: totales({
          ingresos: { 1: 120, 2: 110 },
          egresos: { 1: 50, 2: 45 },
          ganancia: { 1: 30, 2: 25 },
          disponible: { 2: 900 },
        }),
      },
    });
    // ene 2026: sin arqueo propio → null
    expect(out[1].valor).toBeNull();
    // feb 2026: referencia sigue en 1000 (ene no la tocó). delta = 900 - 1000 = -100.
    // término feb = (110-45)-25 = 40. valor = -100 - 40 = -140.
    expect(out[2].valor).toBe(-140);
    // acumulado (computeDiferenciaCajaAcumulada, sin cambios): acc ene = -40, acc feb = -180.
    expect(out[2].acumulado).toBe(-180);
  });

  it("un 0 de valor legítimo en un mes con arqueo se muestra como 0, no como null", () => {
    const out = buildDiferenciaCajaSerie({
      year: 2025,
      primerArqueo: { anio: 2025, mes: 1 },
      totalesPorAnio: {
        2025: totales({ disponible: { 1: 1000, 2: 1000 } }),
      },
    });
    expect(out[1].valor).toBeNull(); // ene, mes del primer arqueo
    expect(out[2].valor).toBe(0);    // feb: valor exactamente 0, NO null
    expect(out[2].acumulado).toBe(0);
  });

  it("año faltante en totalesPorAnio se trata como año vacío (no rompe)", () => {
    const out = buildDiferenciaCajaSerie({
      year: 2026,
      primerArqueo: { anio: 2025, mes: 1 },
      totalesPorAnio: { 2025: totales({ disponible: { 1: 1000 } }) }, // falta 2026
    });
    expect(Object.keys(out)).toHaveLength(12);
    expect(out[1].valor).toBeNull();
  });

  it("hueco multi-mes: el valor por mes diverge del acumulado, ambos se calculan sobre la misma serie", () => {
    const out = buildDiferenciaCajaSerie({
      year: 2025,
      primerArqueo: { anio: 2025, mes: 1 },
      totalesPorAnio: {
        2025: totales({
          ingresos: { 1: 100, 2: 100, 3: 100, 4: 100, 5: 200 },
          egresos: { 1: 40, 2: 40, 3: 40, 4: 40, 5: 50 },
          ganancia: { 1: 20, 2: 20, 3: 20, 4: 20, 5: 30 },
          disponible: { 1: 1000, 5: 1300 }, // feb/mar/abr sin arqueo
        }),
      },
    });
    expect(out[2].valor).toBeNull();
    expect(out[3].valor).toBeNull();
    expect(out[4].valor).toBeNull();
    // may: referencia sigue en 1000. delta = 1300-1000=300. término = (200-50)-30=120. valor=180.
    expect(out[5].valor).toBe(180);
    // acumulado (sin cambios): arrastra el término de feb/mar/abr → 60 (ver resultados-calc.test.ts).
    expect(out[5].acumulado).toBe(60);
  });
});
