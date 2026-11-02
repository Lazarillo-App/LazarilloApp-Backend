// Portado de lazarillo_gestion/lib/etl/normalizers/compras-diff.test.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { describe, it, expect } = require('../../test-utils/vitest');
const { camposErpCambiaron } = require('./compras-diff');

function baseFields(overrides = {}) {
  return {
    codCga: "GASTO1",
    concepto: "Alquiler",
    fecha: new Date("2026-03-15T00:00:00.000Z"),
    codigo: "PROV1",
    proveedor: "Juan Perez",
    detalle: "A 0606-00761530",
    observac: "obs",
    importe: "1000",
    impInt: "0",
    imputac: "X",
    per1: "0",
    per2: "0",
    per3: "0",
    ...overrides,
  };
}

describe("camposErpCambiaron", () => {
  it("mismos campos → false", () => {
    expect(camposErpCambiaron(baseFields(), baseFields())).toBe(false);
  });

  it("fecha con el mismo instante pero instancias de Date distintas → false", () => {
    const a = baseFields({ fecha: new Date("2026-03-15T00:00:00.000Z") });
    const b = baseFields({ fecha: new Date("2026-03-15T00:00:00.000Z") });
    expect(camposErpCambiaron(a, b)).toBe(false);
  });

  it("importe distinto → true", () => {
    expect(camposErpCambiaron(baseFields(), baseFields({ importe: "1200" }))).toBe(true);
  });

  it("fecha distinta → true", () => {
    expect(
      camposErpCambiaron(baseFields(), baseFields({ fecha: new Date("2026-04-01T00:00:00.000Z") }))
    ).toBe(true);
  });

  it("campo descriptivo (detalle) distinto → true, aunque importe sea igual", () => {
    expect(camposErpCambiaron(baseFields(), baseFields({ detalle: "otro detalle" }))).toBe(true);
  });

  it("cada uno de los 12 campos string dispara true individualmente (fecha se cubre aparte)", () => {
    const campos = [
      "codCga", "concepto", "codigo", "proveedor", "detalle", "observac",
      "importe", "impInt", "imputac", "per1", "per2", "per3",
    ];
    for (const campo of campos) {
      expect(
        camposErpCambiaron(baseFields(), baseFields({ [campo]: "DISTINTO" }))
      ).toBe(true);
    }
  });

  it("nulls iguales en ambos lados → false", () => {
    const a = baseFields({ observac: null, proveedor: null });
    const b = baseFields({ observac: null, proveedor: null });
    expect(camposErpCambiaron(a, b)).toBe(false);
  });

  it("un lado null y el otro con valor → true", () => {
    const a = baseFields({ observac: null });
    const b = baseFields({ observac: "algo" });
    expect(camposErpCambiaron(a, b)).toBe(true);
  });
});
