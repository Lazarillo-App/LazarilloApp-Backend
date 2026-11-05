// Portado de lazarillo_gestion/lib/dashboard/anio-range.test.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { describe, it, expect } = require('../test-utils/vitest');
const { resolveAnioRange } = require('./anio-range');

describe("resolveAnioRange", () => {
  it("sin datos: minYear null, maxYear = año actual", () => {
    expect(resolveAnioRange(null, null, 2026)).toEqual({ minYear: null, maxYear: 2026 });
  });

  it("datos enteramente anteriores al año actual: expone el mínimo real y llega hasta el año actual", () => {
    expect(resolveAnioRange(2021, 2024, 2026)).toEqual({ minYear: 2021, maxYear: 2026 });
  });

  it("datos que se extienden más allá del año actual: maxYear sigue al dato", () => {
    expect(resolveAnioRange(2023, 2027, 2026)).toEqual({ minYear: 2023, maxYear: 2027 });
  });

  it("un único año de datos igual al actual", () => {
    expect(resolveAnioRange(2026, 2026, 2026)).toEqual({ minYear: 2026, maxYear: 2026 });
  });
});
