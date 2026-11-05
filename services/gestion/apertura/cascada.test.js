// Portado de lazarillo_gestion/lib/apertura/cascada.test.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { describe, it, expect } = require('../test-utils/vitest');
const { seleccionarReglasCandidatas } = require('./cascada');

function compra(parcial = {}) {
  return { rowId: "r1", conceptoEfectivo: null, proveedorId: null, proveedorTextoNormalizado: null, codigo: null, ...parcial };
}

const ids = (reglas) => reglas.map((r) => r.entidadId);

describe("seleccionarReglasCandidatas", () => {
  it("sin compras liberadas no hay candidatas", () => {
    const reglas = [{ nivel: "concepto", entidadId: "GASTO1" }];
    expect(seleccionarReglasCandidatas(reglas, [])).toEqual([]);
  });

  it("concepto: solo las reglas cuyo concepto efectivo coincide con alguna compra", () => {
    const reglas = [
      { nivel: "concepto", entidadId: "GASTO1" },
      { nivel: "concepto", entidadId: "GASTO2" },
    ];
    const r = seleccionarReglasCandidatas(reglas, [compra({ conceptoEfectivo: "GASTO2" })]);
    expect(ids(r)).toEqual(["GASTO2"]);
  });

  it("registro: solo las reglas cuyo entidadId es el rowId de alguna compra", () => {
    const reglas = [
      { nivel: "registro", entidadId: "r1" },
      { nivel: "registro", entidadId: "r9" },
    ];
    expect(ids(seleccionarReglasCandidatas(reglas, [compra({ rowId: "r1" })]))).toEqual(["r1"]);
  });

  it("proveedor con id real: compara contra proveedorId como texto", () => {
    const reglas = [
      { nivel: "proveedor", entidadId: "123" },
      { nivel: "proveedor", entidadId: "456" },
    ];
    expect(ids(seleccionarReglasCandidatas(reglas, [compra({ proveedorId: 123 })]))).toEqual(["123"]);
  });

  it("proveedor de texto crudo sin código: matchea por nombre normalizado, con proveedorId null", () => {
    const reglas = [
      { nivel: "proveedor", entidadId: "texto:diego" },
      { nivel: "proveedor", entidadId: "texto:otro" },
    ];
    const r = seleccionarReglasCandidatas(reglas, [compra({ proveedorTextoNormalizado: "diego", codigo: "368" })]);
    expect(ids(r)).toEqual(["texto:diego"]);
  });

  it("proveedor de texto crudo con código: exige el mismo código", () => {
    const reglas = [
      { nivel: "proveedor", entidadId: "texto:abril|codigo:368" },
      { nivel: "proveedor", entidadId: "texto:abril|codigo:670" },
    ];
    const r = seleccionarReglasCandidatas(reglas, [compra({ proveedorTextoNormalizado: "abril", codigo: "368" })]);
    expect(ids(r)).toEqual(["texto:abril|codigo:368"]);
  });

  it("proveedor de texto: una compra con proveedorId real nunca matchea por texto (igual que condicionMatchNivel)", () => {
    const reglas = [{ nivel: "proveedor", entidadId: "texto:diego" }];
    const r = seleccionarReglasCandidatas(reglas, [compra({ proveedorId: 7, proveedorTextoNormalizado: "diego" })]);
    expect(r).toEqual([]);
  });

  it("una regla de nivel concepto no matchea por un entidadId que coincide con un rowId", () => {
    const reglas = [{ nivel: "concepto", entidadId: "r1" }];
    expect(seleccionarReglasCandidatas(reglas, [compra({ rowId: "r1", conceptoEfectivo: "OTRO" })])).toEqual([]);
  });

  it("conserva las propiedades extra de la regla y el orden de entrada", () => {
    const reglas = [
      { id: 2, nivel: "concepto", entidadId: "A" },
      { id: 1, nivel: "concepto", entidadId: "B" },
    ];
    const r = seleccionarReglasCandidatas(reglas, [compra({ conceptoEfectivo: "A" }), compra({ rowId: "r2", conceptoEfectivo: "B" })]);
    expect(r.map((x) => x.id)).toEqual([2, 1]);
  });
});
