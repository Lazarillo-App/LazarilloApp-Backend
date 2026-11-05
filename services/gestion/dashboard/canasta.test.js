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
