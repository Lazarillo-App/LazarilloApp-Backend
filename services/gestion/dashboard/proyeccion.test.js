// Portado de lazarillo_gestion/lib/dashboard/proyeccion.test.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { describe, it, expect } = require('../test-utils/vitest');
const { proyectarMes, debeProyectar, fmtMillones } = require('./proyeccion');

// Serie sintética: cada día vende según su día de semana × factor del mes.
const BASE_DOW = [200, 100, 100, 100, 150, 400, 500]; // dom..sáb
function serie(desde, hasta, factor = () => 1) {
  const out = [];
  for (let ms = Date.parse(desde + "T00:00:00Z"); ms <= Date.parse(hasta + "T00:00:00Z"); ms += 86_400_000) {
    const f = new Date(ms).toISOString().slice(0, 10);
    out.push({ fecha: f, total: BASE_DOW[new Date(ms).getUTCDay()] * factor(f) });
  }
  return out;
}
const sumaMes = (d, prefijo) => d.filter((x) => x.fecha.startsWith(prefijo)).reduce((a, b) => a + b.total, 0);

describe("proyectarMes", () => {
  it("con ventas regulares acierta el cierre exacto y el ritmo es 1", () => {
    const todo = serie("2025-09-01", "2026-10-31");
    const hasta21 = todo.filter((d) => d.fecha <= "2026-10-21");
    const r = proyectarMes(hasta21, "2026-10-21");
    expect(r.mes).toBe(10);
    expect(r.diasTranscurridos).toBe(21);
    expect(r.diasRestantes).toBe(10);
    expect(r.ritmo).toBeCloseTo(1, 6);
    expect(r.proyeccion).toBeCloseTo(sumaMes(todo, "2026-10"), 6);
    expect(r.backtest?.meses).toBe(6);
    expect(r.backtest?.errorMetodo).toBeCloseTo(0, 6);
  });

  it("el ritmo del mes se aplica a los días que faltan", () => {
    const d = serie("2026-06-01", "2026-10-21", (f) => (f >= "2026-10-01" ? 1.2 : 1));
    const r = proyectarMes(d, "2026-10-21");
    expect(r.ritmo).toBeGreaterThan(1.1);
    expect(r.proyeccion).toBeGreaterThan(r.facturado + r.estimadoRestante - 1);
    // Los días que faltan (22..31/10) valen su día de semana × ritmo.
    const restantesBase = serie("2026-10-22", "2026-10-31").reduce((a, b) => a + b.total, 0);
    expect(r.estimadoRestante).toBeGreaterThan(restantesBase);
  });

  it("cuenta los días que faltan por día de semana, en orden", () => {
    const r = proyectarMes(serie("2026-08-01", "2026-10-21"), "2026-10-21");
    // 22/10/2026 es jueves; faltan jue, vie, sáb ×2 y dom..mié ×1.
    expect(r.restantesPorDia).toEqual([
      { dow: 4, cantidad: 2 }, { dow: 5, cantidad: 2 }, { dow: 6, cantidad: 2 },
      { dow: 0, cantidad: 1 }, { dow: 1, cantidad: 1 }, { dow: 2, cantidad: 1 }, { dow: 3, cantidad: 1 },
    ]);
  });

  it("regla de 3, mismo ritmo y cierre del año anterior", () => {
    const d = serie("2025-08-01", "2026-10-21", (f) => (f < "2026-01-01" ? 0.5 : 1));
    const r = proyectarMes(d, "2026-10-21");
    expect(r.reglaDeTres).toBeCloseTo((r.facturado / 21) * 31, 6);
    expect(r.cierreAnioAnterior).toBeCloseTo(sumaMes(d, "2025-10"), 6);
    expect(r.mismoRitmoAnioAnterior).not.toBeNull();
  });

  it("sin historia del año anterior ni para el backtest, esos datos quedan en null", () => {
    const r = proyectarMes(serie("2026-10-01", "2026-10-21"), "2026-10-21");
    expect(r.cierreAnioAnterior).toBeNull();
    expect(r.mismoRitmoAnioAnterior).toBeNull();
    expect(r.backtest).toBeNull();
    expect(r.rango).toBeNull();
  });

  it("mes completo o sin ventas → no proyecta", () => {
    expect(proyectarMes(serie("2026-09-01", "2026-09-30"), "2026-09-30")).toBeNull();
    expect(proyectarMes([], "2026-10-21")).toBeNull();
  });

  it("el rango nunca baja de lo ya facturado", () => {
    const d = serie("2026-01-01", "2026-10-21", (f) => (f.slice(5, 7) === "07" ? 2 : 1));
    const r = proyectarMes(d, "2026-10-21");
    expect(r.rango.min).toBeGreaterThanOrEqual(r.facturado);
  });
});

describe("dos métodos y elección por error", () => {
  it("con ventas regulares los dos aciertan y se guarda cada uno", () => {
    const todo = serie("2025-09-01", "2026-10-31");
    const r = proyectarMes(todo.filter((d) => d.fecha <= "2026-10-21"), "2026-10-21");
    const real = sumaMes(todo, "2026-10");
    expect(r.proyecciones.semanas).toBeCloseTo(real, 6);
    expect(r.proyecciones.dias_mes).toBeCloseTo(real, 6);
    expect(r.backtest?.fuente).toBe("backtest");
  });

  it("días del mes: usa el promedio de ese día dentro del mes; si no pasó todavía, el de 8 semanas", () => {
    // Octubre: los sábados del mes venden el doble de lo habitual.
    const d = serie("2026-06-01", "2026-10-21", (f) => (f >= "2026-10-01" && new Date(f + "T00:00:00Z").getUTCDay() === 6 ? 2 : 1));
    const r = proyectarMes(d, "2026-10-21");
    expect(r.proyecciones.dias_mes).toBeGreaterThan(r.proyecciones.semanas);
    // Día 3 (sábado 3/10 recién pasado, sin domingo aún): igual proyecta.
    const r3 = proyectarMes(serie("2026-06-01", "2026-10-02"), "2026-10-02");
    expect(r3.proyecciones.dias_mes).toBeCloseTo(r3.proyecciones.semanas, 6);
  });

  it("con 3+ meses cerrados guardados manda lo guardado y elige el que menos erró", () => {
    const todo = serie("2025-09-01", "2026-10-31");
    const reales = { 7: sumaMes(todo, "2026-07"), 8: sumaMes(todo, "2026-08"), 9: sumaMes(todo, "2026-09") };
    const g = [7, 8, 9].flatMap((mes) => [
      { anio: 2026, mes, metodo: "semanas", proyeccion: reales[mes] * 1.1 },
      { anio: 2026, mes, metodo: "dias_mes", proyeccion: reales[mes] * 0.98 },
      { anio: 2026, mes, metodo: "unico", proyeccion: reales[mes] * 1.05 },
    ]);
    const r = proyectarMes(todo.filter((d) => d.fecha <= "2026-10-21"), "2026-10-21", g);
    expect(r.backtest?.fuente).toBe("guardadas");
    expect(r.backtest?.meses).toBe(3);
    expect(r.metodo).toBe("dias_mes");
    expect(r.backtest?.errores.semanas).toBeCloseTo(0.1, 6);
    expect(r.backtest?.errorMetodo).toBeCloseTo(0.02, 6);
    // Con menos de 3 meses guardados sigue mandando el backtest.
    const r2 = proyectarMes(todo.filter((d) => d.fecha <= "2026-10-21"), "2026-10-21", g.filter((x) => x.mes !== 7));
    expect(r2.backtest?.fuente).toBe("backtest");
  });
});

describe("debeProyectar", () => {
  it("solo el mes en curso incompleto (o el anterior durante la primera semana)", () => {
    expect(debeProyectar("2026-10-21", "2026-10-24")).toBe(true);
    expect(debeProyectar("2026-10-31", "2026-11-02")).toBe(false); // mes completo
    expect(debeProyectar("2026-10-29", "2026-11-03")).toBe(true); // falta importar
    expect(debeProyectar("2026-09-29", "2026-10-24")).toBe(false); // PDV que dejó de vender
    expect(debeProyectar(null, "2026-10-24")).toBe(false);
  });
});

describe("fmtMillones", () => {
  it("formatea compacto", () => {
    expect(fmtMillones(95_287_577)).toBe("$ 95,3 M");
    expect(fmtMillones(450_000)).toBe("$ 450 mil");
  });
});

describe("método único (estacionalidad)", () => {
  // Julio vende el doble todos los años (vacaciones): con 8 semanas de junio, solo el único lo ve venir.
  const julioDoble = (f) => (f.slice(5, 7) === "07" ? 2 : 1);
  const d = serie("2023-04-01", "2026-07-05", julioDoble);
  const real = sumaMes(serie("2026-07-01", "2026-07-31", julioDoble), "2026-07");

  it("el 5 de julio anticipa el salto de julio por los años anteriores", () => {
    const r = proyectarMes(d, "2026-07-05");
    expect(r.estacional).toBeGreaterThan(1.6);
    expect(Math.abs(r.proyecciones.unico - real) / real).toBeLessThan(0.05);
  });

  it("se elige por backtest el que menos erró y con historia es el único", () => {
    const r = proyectarMes(d, "2026-07-05");
    expect(r.metodo).toBe("unico");
    expect(r.backtest.errores.unico).toBeLessThanOrEqual(r.backtest.errores.semanas);
  });

  it("sin años anteriores no hay estacionalidad y no se rompe", () => {
    const r = proyectarMes(serie("2026-05-01", "2026-07-05"), "2026-07-05");
    expect(r.estacional).toBeNull();
    expect(r.proyecciones.unico).toBeGreaterThan(r.facturado);
  });

  it("lo guardado solo manda cuando cada método tiene 3 meses medidos", () => {
    const g = [3, 4, 5].flatMap((mes) => [
      { anio: 2026, mes, metodo: "semanas", proyeccion: 1 },
      { anio: 2026, mes, metodo: "dias_mes", proyeccion: 1 },
    ]);
    expect(proyectarMes(d, "2026-07-05", g).backtest.fuente).toBe("backtest");
  });
});
