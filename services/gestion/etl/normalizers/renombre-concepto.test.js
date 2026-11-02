// Portado de lazarillo_gestion/lib/etl/normalizers/renombre-concepto.test.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { describe, it, expect } = require('../../test-utils/vitest');
const { esRenombreDeConcepto } = require('./compra-identity');

const base = { codCga: "27", fechaISO: "2025-07-19", codigo: "27", concepto: "Inflable Alquiler", comprobante: null, observac: "Cocodrilo", importe: "68000" };

describe("esRenombreDeConcepto", () => {
  it("mismo gasto con el concepto renombrado en MaxiRest → es el mismo registro", () => {
    expect(esRenombreDeConcepto(base, { ...base, concepto: "Inflable" })).toBe(true);
  });
  it("no une si cambia otra cosa además del nombre", () => {
    expect(esRenombreDeConcepto(base, { ...base, concepto: "Inflable", importe: "68001" })).toBe(false);
    expect(esRenombreDeConcepto(base, { ...base, concepto: "Inflable", observac: "Pochoclera" })).toBe(false);
    expect(esRenombreDeConcepto(base, { ...base, concepto: "Inflable", codCga: "28" })).toBe(false);
    expect(esRenombreDeConcepto(base, { ...base, concepto: "Inflable", comprobante: "A000100000001" })).toBe(false);
  });
  it("sin observación no alcanza (dos pagos distintos pueden coincidir en todo)", () => {
    expect(esRenombreDeConcepto({ ...base, observac: null }, { ...base, observac: null, concepto: "Inflable" })).toBe(false);
  });
  it("mismo nombre de concepto no es un renombre", () => {
    expect(esRenombreDeConcepto(base, { ...base })).toBe(false);
  });
});
