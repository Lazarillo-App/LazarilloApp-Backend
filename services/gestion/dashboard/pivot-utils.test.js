// Portado de lazarillo_gestion/lib/dashboard/pivot-utils.test.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { describe, it, expect } = require('../test-utils/vitest');
const { sortPivotRows, sortPivotRowsPorProveedor, flattenRowsPorProveedor } = require('./pivot-utils');

function rubroRow(overrides) {
  return {
    level: 0, id: "R1", nombre: "Rubro 1", rubroCodigo: "R1",
    values: {}, rowTotal: 0, children: [],
    ...overrides,
  };
}

function proveedorRow(overrides) {
  return {
    level: 1, id: "R1|1", nombre: "Proveedor A", proveedorId: 1, proveedorTexto: null, codigo: null, rubroCodigo: "R1", entidadIdProveedor: "1",
    values: {}, rowTotal: 0, children: [],
    ...overrides,
  };
}

function rubroRowConcepto(overrides) {
  return {
    level: 0, id: "R1", nombre: "Rubro 1", rubroCodigo: "R1",
    values: {}, rowTotal: 0, children: [],
    ...overrides,
  };
}

function conceptoRow(overrides) {
  return {
    level: 1, id: "C1", nombre: "Concepto 1", conceptoCodigo: "C1", rubroCodigo: "R1",
    values: {}, rowTotal: 0, children: [],
    ...overrides,
  };
}

describe("sortPivotRowsPorProveedor", () => {
  it("ordena rubros por total descendente", () => {
    const rows = [rubroRow({ id: "r1", rowTotal: 100 }), rubroRow({ id: "r2", rowTotal: 300 })];
    const sorted = sortPivotRowsPorProveedor(rows, "total", "desc");
    expect(sorted.map((r) => r.id)).toEqual(["r2", "r1"]);
  });

  it("no muta el array original", () => {
    const rows = [rubroRow({ id: "r1", rowTotal: 100 }), rubroRow({ id: "r2", rowTotal: 300 })];
    sortPivotRowsPorProveedor(rows, "total", "desc");
    expect(rows.map((r) => r.id)).toEqual(["r1", "r2"]);
  });

  it("desempata rubros por nombre alfabético cuando el total es igual", () => {
    const rows = [
      rubroRow({ id: "r1", nombre: "Zapatos", rowTotal: 100 }),
      rubroRow({ id: "r2", nombre: "Alimentos", rowTotal: 100 }),
    ];
    const sorted = sortPivotRowsPorProveedor(rows, "total", "desc");
    expect(sorted.map((r) => r.nombre)).toEqual(["Alimentos", "Zapatos"]);
  });

  it("desempata proveedores hijos por nombre cuando el total es igual", () => {
    const rubro = rubroRow({
      id: "r1",
      children: [
        proveedorRow({ id: "r1|1", nombre: "Ruta Verde", rowTotal: 50 }),
        proveedorRow({ id: "r1|2", nombre: "Agronatural", rowTotal: 50 }),
      ],
    });
    const sorted = sortPivotRowsPorProveedor([rubro], "total", "desc");
    expect(sorted[0].children.map((p) => p.nombre)).toEqual(["Agronatural", "Ruta Verde"]);
  });
});

describe("sortPivotRows", () => {
  it("ordena rubros por total descendente", () => {
    const rows = [rubroRowConcepto({ id: "r1", rowTotal: 100 }), rubroRowConcepto({ id: "r2", rowTotal: 300 })];
    const sorted = sortPivotRows(rows, "total", "desc");
    expect(sorted.map((r) => r.id)).toEqual(["r2", "r1"]);
  });

  it("desempata rubros por nombre alfabético cuando el total es igual", () => {
    const rows = [
      rubroRowConcepto({ id: "r1", nombre: "Zapatos", rowTotal: 100 }),
      rubroRowConcepto({ id: "r2", nombre: "Alimentos", rowTotal: 100 }),
    ];
    const sorted = sortPivotRows(rows, "total", "desc");
    expect(sorted.map((r) => r.nombre)).toEqual(["Alimentos", "Zapatos"]);
  });

  it("desempata conceptos hijos por nombre cuando el total es igual", () => {
    const rubro = rubroRowConcepto({
      id: "r1",
      children: [
        conceptoRow({ id: "c1", nombre: "Verduleria", rowTotal: 50 }),
        conceptoRow({ id: "c2", nombre: "Almacen", rowTotal: 50 }),
      ],
    });
    const sorted = sortPivotRows([rubro], "total", "desc");
    expect(sorted[0].children.map((c) => c.nombre)).toEqual(["Almacen", "Verduleria"]);
  });
});

describe("flattenRowsPorProveedor", () => {
  it("solo incluye el nivel rubro cuando no hay nada expandido", () => {
    const data = { rows: [rubroRow({ id: "r1" })], columnTotals: {}, grandTotal: 0 };
    const flat = flattenRowsPorProveedor(data, new Set());
    expect(flat).toEqual([{ type: "rubroTop", data: data.rows[0] }]);
  });

  it("expande rubro, proveedor y concepto en cascada", () => {
    const linea = {
      level: 3, id: "l1", rowId: "row-1", distribucionId: null, conceptoCodigo: "C1",
      fecha: null, observac: null, importe: 10, hasManualOverride: false,
      localIdOrigen: null, puntoDeVentaIdOrigen: null, values: {}, rowTotal: 10,
    };
    const concepto = {
      level: 2, id: "r1|p1|C1", nombre: "Concepto 1", conceptoCodigo: "C1", rubroCodigo: "r1", proveedorId: 1, proveedorTexto: null, codigo: null,
      values: {}, rowTotal: 10, children: [linea],
    };
    const proveedor = proveedorRow({ id: "r1|p1", children: [concepto] });
    const rubro = rubroRow({ id: "r1", children: [proveedor] });
    const data = { rows: [rubro], columnTotals: {}, grandTotal: 10 };

    const flat = flattenRowsPorProveedor(data, new Set(["r1", "r1|p1", "r1|p1|C1"]));
    expect(flat.map((f) => f.type)).toEqual(["rubroTop", "proveedorSub", "conceptoSub", "linea"]);
  });

  it("no expande proveedor si el rubro padre no está expandido", () => {
    const proveedor = proveedorRow({ id: "r1|p1" });
    const rubro = rubroRow({ id: "r1", children: [proveedor] });
    const data = { rows: [rubro], columnTotals: {}, grandTotal: 10 };

    const flat = flattenRowsPorProveedor(data, new Set(["r1|p1"]));
    expect(flat).toEqual([{ type: "rubroTop", data: rubro }]);
  });

  it("no expande concepto si el proveedor padre no está expandido", () => {
    const concepto = {
      level: 2, id: "r1|p1|C1", nombre: "Concepto 1", conceptoCodigo: "C1", rubroCodigo: "r1", proveedorId: 1, proveedorTexto: null, codigo: null,
      values: {}, rowTotal: 10, children: [],
    };
    const proveedor = proveedorRow({ id: "r1|p1", children: [concepto] });
    const rubro = rubroRow({ id: "r1", children: [proveedor] });
    const data = { rows: [rubro], columnTotals: {}, grandTotal: 10 };

    const flat = flattenRowsPorProveedor(data, new Set(["r1", "r1|p1|C1"]));
    expect(flat.map((f) => f.type)).toEqual(["rubroTop", "proveedorSub"]);
  });
});
