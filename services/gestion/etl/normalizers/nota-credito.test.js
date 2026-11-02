// Portado de lazarillo_gestion/lib/etl/normalizers/nota-credito.test.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { describe, it, expect } = require('../../test-utils/vitest');
const { esNotaCredito, normalizarSignoNotaCredito } = require('./nota-credito');

describe("esNotaCredito", () => {
  it.each(["NC 0008-00000237", "NcA 0008-00292082", "NcB 0004-00004607", "NcC 0001-00000001", "  ncb 0004-00004607"])(
    "reconoce %j como nota de crédito",
    (detalle) => {
      expect(esNotaCredito(detalle)).toBe(true);
    }
  );

  it.each([
    "FcA 0004-00507298",
    "Tic 1640-06082024",
    "NcX 0001-00000001",
    "NCO 0001-00000001",
    "NCB",
    "Pedir Nc por 1 pomelo",
    "",
    null,
    undefined,
  ])("no reconoce %j", (detalle) => {
    expect(esNotaCredito(detalle)).toBe(false);
  });
});

describe("normalizarSignoNotaCredito", () => {
  it("invierte una NcB con importe positivo", () => {
    expect(normalizarSignoNotaCredito("NcB 0004-00004607", "287999")).toBe("-287999");
  });

  it("invierte una NcA con importe positivo y decimales", () => {
    expect(normalizarSignoNotaCredito("NcA 0008-00003119", "23422.60")).toBe("-23422.60");
  });

  it("deja intacta una NC que ya viene negativa (idempotente, sin doble inversión)", () => {
    expect(normalizarSignoNotaCredito("NC 0008-00000237", "-61705")).toBe("-61705");
  });

  it("deja intacto un importe 0", () => {
    expect(normalizarSignoNotaCredito("NC 0003-00000010", "0")).toBe("0");
  });

  it("deja intacto un importe null", () => {
    expect(normalizarSignoNotaCredito("NcB 0004-00004607", null)).toBeNull();
  });

  it("no toca una factura aunque Observación hable de una NC", () => {
    expect(normalizarSignoNotaCredito("FcA 0004-00507298", "24369.27")).toBe("24369.27");
  });

  it("no toca un Tic con importe positivo", () => {
    expect(normalizarSignoNotaCredito("Tic 1640-06082024", "108706")).toBe("108706");
  });

  it("no toca un detalle null", () => {
    expect(normalizarSignoNotaCredito(null, "100")).toBe("100");
  });
});
