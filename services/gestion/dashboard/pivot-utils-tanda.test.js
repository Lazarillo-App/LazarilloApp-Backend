// Portado de lazarillo_gestion/lib/dashboard/pivot-utils-tanda.test.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { describe, it, expect } = require('../test-utils/vitest');
const { flattenRows, TANDA_PIVOT } = require('./pivot-utils');

const prov = (i) => ({ level: 2, id: `c|r${i}`, rowId: `r${i}`, values: { 1: 1 }, rowTotal: 1 });
const datos = (n) => ({
  rows: [{
    level: 0, id: "R", nombre: "R", rubroCodigo: "R", values: {}, rowTotal: n,
    children: [{ level: 1, id: "R|C", nombre: "C", conceptoCodigo: "C", rubroCodigo: "R", values: {}, rowTotal: n, children: Array.from({ length: n }, (_, i) => prov(i)) }],
  }],
  columnTotals: {}, grandTotal: n,
});
const abierto = new Set(["R", "R|C"]);

describe("flattenRows por tandas", () => {
  it("sin mapa muestra todo (ventas y otros usos)", () => {
    expect(flattenRows(datos(250), abierto, 3).filter((f) => f.type === "proveedor")).toHaveLength(250);
  });
  it("con mapa muestra la primera tanda y una fila 'mas'", () => {
    const filas = flattenRows(datos(250), abierto, 3, new Map());
    expect(filas.filter((f) => f.type === "proveedor")).toHaveLength(TANDA_PIVOT);
    const mas = filas.at(-1);
    expect(mas).toEqual({ type: "mas", data: { id: "R|C|mas", conceptoId: "R|C", mostrados: TANDA_PIVOT, total: 250 } });
  });
  it("ver más suma y ver todos no deja fila 'mas'", () => {
    expect(flattenRows(datos(250), abierto, 3, new Map([["R|C", 200]])).filter((f) => f.type === "proveedor")).toHaveLength(200);
    const todos = flattenRows(datos(250), abierto, 3, new Map([["R|C", Infinity]]));
    expect(todos.filter((f) => f.type === "proveedor")).toHaveLength(250);
    expect(todos.some((f) => f.type === "mas")).toBe(false);
  });
  it("concepto chico: sin fila 'mas'", () => {
    expect(flattenRows(datos(TANDA_PIVOT), abierto, 3, new Map()).some((f) => f.type === "mas")).toBe(false);
  });
});
