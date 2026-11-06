// Portado de lazarillo_gestion/lib/dashboard/canasta.test.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { describe, expect, it } = require('../test-utils/vitest');
const { acumulada, canastaMensual, mesesHasta, pesoRelativo, ventanaUltimoAumento } = require('./canasta');

describe("mesesHasta", () => {
  it("cruza el año", () => {
    expect(mesesHasta(2026, 2, 4)).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
  });
});

const comps = [
  { clave: "mercaderias", nombre: "Mercaderías", peso: 27, variaciones: [0.02, -0.04, 0.1], cuenta: true },
  { clave: "sueldos", nombre: "Sueldos", peso: 34, variaciones: [0.036, 0, null], cuenta: true },
  { clave: "servicios", nombre: "Servicios", peso: 6, variaciones: [null, 0.011, 0.035], cuenta: true },
  { clave: "alquiler", nombre: "Alquiler", peso: 11, variaciones: [0, 0.61, 0], cuenta: false },
];

describe("canastaMensual", () => {
  it("pondera por peso, saltea faltantes y lo que no cuenta (alquiler en revisión)", () => {
    const c = canastaMensual(comps, 3);
    expect(c[0]).toBeCloseTo((0.02 * 27 + 0.036 * 34) / 61);
    expect(c[1]).toBeCloseTo((-0.04 * 27 + 0 * 34 + 0.011 * 6) / 67);
    expect(c[2]).toBeCloseTo((0.1 * 27 + 0.035 * 6) / 33);
  });
  it("sin componentes con dato = null", () => {
    expect(canastaMensual([{ ...comps[3] }], 2)).toEqual([null, null]);
  });
});

describe("acumulada", () => {
  it("compone y saltea nulls", () => {
    expect(acumulada([0.1, null, 0.1], 0, 2)).toBeCloseTo(0.21);
    expect(acumulada([null, null], 0, 1)).toBeNull();
    expect(acumulada([0.1, 0.2], 2, 1)).toBeNull();
  });
});

describe("ventanaUltimoAumento", () => {
  const meses = ["2026-06", "2026-07", "2026-08", "2026-09"];
  it("toma el último aumento hasta el mes de referencia y cuenta desde el mes siguiente", () => {
    expect(ventanaUltimoAumento(meses, ["2026-06-15", "2026-08-24", "2026-10-19"])).toEqual({ base: "2026-08-24", desdeIdx: 3, posterior: "2026-10-19" });
  });
  it("aumento en el mes de referencia: ventana vacía", () => {
    expect(ventanaUltimoAumento(meses, ["2026-09-02"]).desdeIdx).toBe(4);
  });
  it("sin aumentos", () => {
    expect(ventanaUltimoAumento(meses, [])).toEqual({ base: null, desdeIdx: null, posterior: null });
  });
});

describe("pesoRelativo", () => {
  it("solo entre los que cuentan", () => {
    const p = pesoRelativo(comps);
    expect(p.get("alquiler")).toBe(0);
    expect(p.get("sueldos")).toBeCloseTo(34 / 67);
  });
});

describe("estimarIncompletos (sueldos a medio cargar, Diego 06/11/2026)", () => {
  const { estimarIncompletos } = require('./canasta');
  const st = (n, tot) => ({ n, tot });
  it("Comercio oct-26: 9 de 13 empleados y la mitad del total → se estima con el promedio, nunca negativo", () => {
    const stats = [st(13, 16), st(13, 16.2), st(13, 16.5), st(13, 16.6), st(13, 18.8), st(9, 10.9)];
    const r = estimarIncompletos([0.012, 0.016, 0.042, 0.078, -0.023], stats);
    expect(r.estimados).toEqual([false, false, false, false, true]);
    const geo = Math.exp((Math.log(1.012) + Math.log(1.016) + Math.log(1.042) + Math.log(1.078)) / 4) - 1;
    expect(r.variaciones[4]).toBeCloseTo(geo, 10);
  });
  it("el mes siguiente a uno incompleto también se estima (se compara contra un mes a medias)", () => {
    const stats = [st(10, 10), st(10, 10.1), st(10, 10.2), st(10, 10.4), st(5, 5), st(10, 10.6)];
    const r = estimarIncompletos([0.01, 0.01, 0.02, -0.5, 1], stats);
    expect(r.estimados).toEqual([false, false, false, true, true]);
    const geo = Math.exp((2 * Math.log(1.01) + Math.log(1.02)) / 3) - 1;
    expect(r.variaciones[3]).toBeCloseTo(geo, 10);
    expect(r.variaciones[4]).toBeCloseTo(geo, 10);
  });
  it("mes sin sueldos cargados → estimado; promedio negativo → 0; con menos de 3 meses medidos → 0", () => {
    const r = estimarIncompletos([-0.05, -0.05, -0.05, null], [st(10, 10), st(10, 9.5), st(10, 9.1), st(10, 8.6), null]);
    expect(r.estimados).toEqual([false, false, false, true]);
    expect(r.variaciones[3]).toBe(0);
    const r2 = estimarIncompletos([0.089, null], [st(15, 13), st(15, 14.9), null]);
    expect(r2.variaciones).toEqual([0.089, 0]);
    expect(r2.estimados).toEqual([false, true]);
  });
  it("meses completos no se tocan; sin historia no inventa", () => {
    const r = estimarIncompletos([0.03, 0.01], [st(10, 10), st(10, 10.3), st(10, 10.4)]);
    expect(r).toEqual({ variaciones: [0.03, 0.01], estimados: [false, false], puenteados: [false, false] });
    const r2 = estimarIncompletos([null], [null, null]);
    expect(r2.variaciones).toEqual([null]);
    expect(r2.estimados).toEqual([false]);
  });
  it("salta y vuelve (Comercio ago +16,2% / sep −9,5%) → se puentea: los dos con la raíz del cambio conjunto", () => {
    const stats = [st(13, 16), st(13, 16.2), st(12, 16.6), st(13, 18.8)];
    const r = estimarIncompletos([0.012, 0.1623, -0.0947], stats);
    const v = Math.sqrt(1.1623 * 0.9053) - 1;
    expect(r.puenteados).toEqual([false, true, true]);
    expect(r.variaciones[1]).toBeCloseTo(v, 10);
    expect(r.variaciones[2]).toBeCloseTo(v, 10);
  });
  it("un sueldo nunca baja: una variación negativa suelta queda en 0", () => {
    const r = estimarIncompletos([-0.037, 0.02], [st(10, 10), st(10, 9.7), st(10, 9.9)]);
    expect(r.variaciones).toEqual([0, 0.02]);
  });
});
