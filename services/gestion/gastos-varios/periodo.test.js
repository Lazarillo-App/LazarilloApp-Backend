// Portado de lazarillo_gestion/lib/gastos-varios/periodo.test.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { describe, it, expect } = require('../test-utils/vitest');
const { fechaDelPeriodo, moverPeriodo, nombrePeriodo, periodoDe, siguienteNumeroGV } = require('./periodo');

describe("período de gastos varios", () => {
  it("la fecha va al 15 del período", () => {
    expect(fechaDelPeriodo("2026-07")).toBe("2026-07-15");
    expect(periodoDe("2026-10-27")).toBe("2026-10");
  });
  it("‹ › cruza el año", () => {
    expect(moverPeriodo("2026-01", -1)).toBe("2025-12");
    expect(moverPeriodo("2026-12", 1)).toBe("2027-01");
    expect(moverPeriodo("2026-10", 0)).toBe("2026-10");
  });
  it("nombre del mes", () => {
    expect(nombrePeriodo("2026-10")).toBe("Octubre 2026");
  });
  it("numeración interna 9999-NNNNNNNN", () => {
    expect(siguienteNumeroGV(null)).toBe("00000001");
    expect(siguienteNumeroGV("Z999900000041")).toBe("00000042");
    expect(siguienteNumeroGV("basura")).toBe("00000001");
  });
});
