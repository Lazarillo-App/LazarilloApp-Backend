// Portado de lazarillo_gestion/lib/facturas/insumos.test.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { describe, it, expect } = require('../test-utils/vitest');
const { factorEnvase, unirInsumos } = require('./insumos');

const m = (codigo, nombre, codCga, extra = {}) => ({ codigo, nombre, medida: "K", rubro: "Carnes", codCga, precio: 100, discontinuado: false, envases: [], ...extra });

describe("unirInsumos", () => {
  it("el concepto sale del rubro aunque la compra no lo tenga", () => {
    const r = unirInsumos([m("505", "Carne Picada Cerdo", "4")], [{ codigo: "505", nombre: "Carne Picada Cerdo", medida: "K", codCga: null, unit: 9000, alic: 10.5 }]);
    expect(r).toEqual([{ codigo: "505", nombre: "Carne Picada Cerdo", medida: "K", codCga: "4", rubro: "Carnes", unit: 9000, alic: 10.5, envases: [] }]);
  });
  it("rubro sin concepto: usa el de la última compra; sin compra, precio del maestro", () => {
    const r = unirInsumos([m("1", "A", null), m("2", "B", null)], [{ codigo: "1", nombre: "A", medida: "K", codCga: "7", unit: 5, alic: 21 }]);
    expect(r.map((x) => [x.codCga, x.unit])).toEqual([["7", 5], [null, 100]]);
  });
  it("saca discontinuados, suma los que solo están en el 25 y desambigua nombres", () => {
    const r = unirInsumos([m("1", "A", "1", { discontinuado: true }), m("2", "X", "1"), m("3", "X", "1")], [{ codigo: "9", nombre: "Z", medida: "U", codCga: "3", unit: 1, alic: 21 }, { codigo: "1", nombre: "A", medida: "K", codCga: "1", unit: 1, alic: 21 }]);
    expect(r.map((x) => x.nombre)).toEqual(["X (2)", "X (3)", "Z"]);
  });
  it("último precio por envase (X8): se pasa a la unidad", () => {
    const coca = m("1241", "Coca 1.75L", "6", { medida: "U", envases: [{ envase: "X8", factor: 8 }] });
    const r = unirInsumos([coca], [{ codigo: "1241", nombre: "Coca 1.75L", medida: "X8", codCga: "6", unit: 15613.83, alic: 21 }]);
    expect([r[0].medida, r[0].unit]).toEqual(["U", 1951.73]);
  });
});

describe("factorEnvase", () => {
  const coca = { medida: "U", envases: [{ envase: "X8", factor: 8 }, { envase: "Pack", factor: 12 }] };
  it("unidad = 1, envase = su factor (sin importar mayúsculas), desconocido = null", () => {
    expect(factorEnvase(coca, "U")).toBe(1);
    expect(factorEnvase(coca, " x8 ")).toBe(8);
    expect(factorEnvase(coca, "PACK")).toBe(12);
    expect(factorEnvase(coca, "X6")).toBeNull();
    expect(factorEnvase(null, "X8")).toBeNull();
  });
});
