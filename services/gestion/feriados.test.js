// Portado de lazarillo_gestion/lib/feriados.test.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { describe, it, expect } = require('./test-utils/vitest');
const { esConceptoFeriado, feriadosDelMes } = require('./feriados');

describe("feriados", () => {
  it("septiembre no tiene feriados nacionales; octubre sí", () => {
    expect(feriadosDelMes("2026-09")).toEqual([]);
    expect(feriadosDelMes("2026-10")).toEqual(["2026-10-12"]);
    expect(feriadosDelMes("2025-09")).toEqual([]);
  });
  it("año sin calendario: no se sabe", () => {
    expect(feriadosDelMes("2030-09")).toBeNull();
  });
  it("reconoce el concepto", () => {
    expect(esConceptoFeriado("Feriados")).toBe(true);
    expect(esConceptoFeriado("Liquidacion Sueldo")).toBe(false);
  });
});
