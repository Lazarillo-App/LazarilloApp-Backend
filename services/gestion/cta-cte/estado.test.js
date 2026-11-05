// Portado de lazarillo_gestion/lib/cta-cte/estado.test.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { describe, it, expect } = require('../test-utils/vitest');
const { claveComprobante, estadoPago, filtrarPorPeriodo, totalesCtaCte } = require('./estado');

const D = "2025-09-01";
const f = (comprobante, total, pagado, fecha = "2026-02-03", pagoAutomatico = false) =>
  ({ comprobante, fecha, total, pagado, pagoAutomatico });

describe("estado de pago de un comprobante", () => {
  it("paga, parcial, impaga", () => {
    expect(estadoPago(f("Z000101182611", 55614.02, 55614.02), D)).toBe("paga");
    expect(estadoPago(f("Z000101182611", 55614.02, 31753.93), D)).toBe("parcial");
    expect(estadoPago(f("A000400862994", 252276.18, 0), D)).toBe("impaga");
    expect(estadoPago(f("A000400862994", 100, 99.5), D)).toBe("paga"); // redondeo de centavos
  });
  it("pago automático solo si no tiene pagos", () => {
    expect(estadoPago(f("A1", 100, 0, "2026-01-01", true), D)).toBe("auto");
    expect(estadoPago(f("A1", 100, 40, "2026-01-01", true), D)).toBe("parcial");
  });
  it("sin estado: sin comprobante o gasto vario interno", () => {
    expect(estadoPago(f(null, 100, 0), D)).toBeNull();
    expect(estadoPago(f("E001120251014", 100, 0), D)).toBeNull();
    expect(estadoPago(f("G048620260108", 100, 0), D)).toBeNull();
  });
  it("nota de crédito y antes de que el 80 cubra", () => {
    expect(estadoPago(f("N000100000012", -500, 0), D)).toBe("nc");
    expect(estadoPago(f("A1", 100, 0, "2025-06-10"), D)).toBe("sin-datos");
    expect(estadoPago(f("A1", 100, 100, "2025-06-10"), D)).toBe("paga");
  });
  it("clave y período", () => {
    expect(claveComprobante(3, "Z1", "485")).toBe("3|Z1|485");
    expect(claveComprobante(3, null, "485")).toBeNull();
    const l = [{ fecha: "2026-02-03" }, { fecha: "2025-12-01" }];
    expect(filtrarPorPeriodo(l, { modo: "anio", anio: 2026 })).toHaveLength(1);
    expect(filtrarPorPeriodo(l, { modo: "todo", anio: 2026 })).toHaveLength(2);
  });
  it("totales: el saldo es solo lo impago o parcial", () => {
    expect(totalesCtaCte([
      { total: 100, pagado: 100, estado: "paga" },
      { total: 200, pagado: 50, estado: "parcial" },
      { total: 300, pagado: 0, estado: "auto" },
      { total: 80, pagado: 0, estado: "impaga" },
    ])).toEqual({ total: 680, pagado: 150, saldo: 230, impagas: 2 });
  });
});
