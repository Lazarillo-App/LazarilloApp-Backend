// Portado de lazarillo_gestion/lib/empleados/concepto-fijo.test.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { describe, expect, it } = require('../test-utils/vitest');
const { describirPeriodo, errorVigencia, superposicion } = require('./concepto-fijo');

const base = { id: 1, entidadId: "texto:camila|codigo:597", nombre: "Camila", origenPuntoDeVentaId: 1, conceptoCodigo: "50",
  modo: "desde_adelante", fechaDesde: "2026-09-01T00:00:00.000Z", fechaHasta: null, extremosInclusivos: true };

describe("concepto fijo por empleado", () => {
  it("valida las fechas que pide cada período", () => {
    expect(errorVigencia({ modo: "historico", fechaDesde: null, fechaHasta: null })).toBeNull();
    expect(errorVigencia({ modo: "desde_adelante", fechaDesde: null, fechaHasta: null })).toMatch(/desde/);
    expect(errorVigencia({ modo: "entre_fechas", fechaDesde: "2026-10-01", fechaHasta: "2026-09-01" })).toMatch(/posterior/);
  });
  it("no deja dos reglas del mismo empleado con períodos que se pisan (otro PDV u otro empleado sí)", () => {
    const nueva = { ...base, id: undefined, modo: "desde_atras", fechaDesde: null, fechaHasta: "2026-09-01T00:00:00.000Z" };
    expect(superposicion(nueva, [base])).toBe(1); // el 01/09 queda en las dos (extremos incluidos)
    expect(superposicion({ ...nueva, extremosInclusivos: false }, [{ ...base, extremosInclusivos: false }])).toBeNull();
    expect(superposicion({ ...nueva, origenPuntoDeVentaId: 2 }, [base])).toBeNull();
    expect(superposicion({ ...nueva, entidadId: "texto:brian|codigo:544" }, [base])).toBeNull();
    expect(superposicion({ ...base }, [base])).toBeNull(); // editar la misma regla
  });
  it("describe el período", () => {
    expect(describirPeriodo(base)).toBe("desde 01/09/2026");
    expect(describirPeriodo({ modo: "historico", fechaDesde: null, fechaHasta: null })).toBe("todo el histórico");
  });
});
