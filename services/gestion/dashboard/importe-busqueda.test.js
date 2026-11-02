// Portado de lazarillo_gestion/lib/dashboard/importe-busqueda.test.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { describe, it, expect } = require('../test-utils/vitest');
const { parsearImporte } = require('./importe-busqueda');

describe("parsearImporte", () => {
  it("entero sin separadores → sin centavos", () => {
    expect(parsearImporte("811980")).toEqual({ valor: "811980", conCentavos: false });
  });

  it("miles con punto (es-AR) → sin centavos", () => {
    expect(parsearImporte("811.980")).toEqual({ valor: "811980", conCentavos: false });
    expect(parsearImporte("1.234.567")).toEqual({ valor: "1234567", conCentavos: false });
  });

  it("centavos con coma, con o sin miles → exacto", () => {
    expect(parsearImporte("811980,50")).toEqual({ valor: "811980.50", conCentavos: true });
    expect(parsearImporte("811.980,5")).toEqual({ valor: "811980.50", conCentavos: true });
  });

  it("centavos con punto (tipeo rápido) → exacto; un punto con 3 dígitos es miles, no centavos", () => {
    expect(parsearImporte("811980.50")).toEqual({ valor: "811980.50", conCentavos: true });
    expect(parsearImporte("811.980")).toEqual({ valor: "811980", conCentavos: false });
  });

  it("ignora $, espacios y signo", () => {
    expect(parsearImporte("$ 811.980")).toEqual({ valor: "811980", conCentavos: false });
    expect(parsearImporte("-811.980,00")).toEqual({ valor: "811980.00", conCentavos: true });
    expect(parsearImporte(" 811 980 ")).toEqual({ valor: "811980", conCentavos: false });
  });

  it("menos de 3 dígitos enteros o texto → null", () => {
    expect(parsearImporte("12")).toBeNull();
    expect(parsearImporte("12,50")).toBeNull();
    expect(parsearImporte("coca")).toBeNull();
    expect(parsearImporte("571 - Ricardo")).toBeNull();
    expect(parsearImporte("")).toBeNull();
    expect(parsearImporte("1.23")).toBeNull(); // 1,23: parte entera de 1 dígito
    expect(parsearImporte("12.3456")).toBeNull(); // ni miles ni centavos válidos
  });
});
