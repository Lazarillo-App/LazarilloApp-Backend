// Portado de lazarillo_gestion/lib/dashboard/equilibrio-config.test.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { describe, expect, it } = require('../test-utils/vitest');
const { cambioValido, cambiosEntre, etiquetaPct, mapaVariables, pctEfectivo, variableDe } = require('./equilibrio-config');

const vars = mapaVariables([
  { tipo: "rubro", codigo: "1", pct: 100 },     // Mercaderías
  { tipo: "rubro", codigo: "2", pct: 30 },      // Servicios
  { tipo: "concepto", codigo: "104", pct: 100 }, // Feriados (rubro personal fijo)
  { tipo: "concepto", codigo: "9", pct: 0 },    // un concepto de Mercaderías marcado fijo
]);

describe("pctEfectivo", () => {
  it("el concepto manda sobre el rubro, incluso en 0", () => {
    expect(pctEfectivo(vars, "3", "104")).toBe(100);
    expect(pctEfectivo(vars, "1", "9")).toBe(0);
    expect(pctEfectivo(vars, "1", "5")).toBe(100);
    expect(pctEfectivo(vars, "2", "20")).toBe(30);
    expect(pctEfectivo(vars, "21", "50")).toBe(0);
    expect(pctEfectivo(vars, null, "50")).toBe(0);
  });
});

describe("variableDe", () => {
  const g = [
    { rubroCodigo: "1", rubro: "Mercaderías", codigo: "5", nombre: "Carnes", prom: 10, mes: 12 },
    { rubroCodigo: "1", rubro: "Mercaderías", codigo: "9", nombre: "Envases", prom: 2, mes: 2 },
    { rubroCodigo: "2", rubro: "Servicios", codigo: "20", nombre: "Luz", prom: 10, mes: 10 },
    { rubroCodigo: "3", rubro: "Personal", codigo: "104", nombre: "Feriados", prom: 1, mes: 3 },
    { rubroCodigo: "21", rubro: "Alquiler", codigo: "50", nombre: "Alquiler", prom: 11, mes: 11 },
  ];
  it("suma importe × % efectivo", () => {
    expect(variableDe(g, vars, "prom")).toBeCloseTo(10 + 3 + 1);
    expect(variableDe(g, vars, "mes")).toBeCloseTo(12 + 3 + 3);
  });
});

describe("etiquetas y cambios", () => {
  it("etiqueta", () => {
    expect(etiquetaPct(undefined)).toBe("Fijo");
    expect(etiquetaPct(0)).toBe("Fijo");
    expect(etiquetaPct(100)).toBe("Variable");
    expect(etiquetaPct(30)).toBe("30%");
  });
  it("cambios: altas, modificaciones y bajas", () => {
    const orig = mapaVariables([{ tipo: "rubro", codigo: "1", pct: 100 }, { tipo: "rubro", codigo: "2", pct: 30 }]);
    const draft = new Map(orig); draft.set("rubro:2", 50); draft.delete("rubro:1"); draft.set("concepto:104", 100);
    expect(cambiosEntre(orig, draft)).toEqual([
      { tipo: "rubro", codigo: "2", pct: 50 },
      { tipo: "concepto", codigo: "104", pct: 100 },
      { tipo: "rubro", codigo: "1", pct: null },
    ]);
    expect(cambiosEntre(orig, new Map(orig))).toEqual([]);
  });
  it("valida", () => {
    expect(cambioValido({ tipo: "rubro", codigo: "1", pct: 100 })).toBe(true);
    expect(cambioValido({ tipo: "concepto", codigo: "104", pct: null })).toBe(true);
    expect(cambioValido({ tipo: "rubro", codigo: "1", pct: 101 })).toBe(false);
    expect(cambioValido({ tipo: "otro", codigo: "1", pct: 1 })).toBe(false);
    expect(cambioValido({ tipo: "rubro", codigo: " ", pct: 1 })).toBe(false);
  });
});
