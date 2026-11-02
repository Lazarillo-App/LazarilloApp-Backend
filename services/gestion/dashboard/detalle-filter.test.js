// Portado de lazarillo_gestion/lib/dashboard/detalle-filter.test.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { describe, it, expect } = require('../test-utils/vitest');
const { buildDetalleFilter } = require('./detalle-filter');

const base = { year: 2026, localId: 1, pdvId: 2 };

describe("buildDetalleFilter", () => {
  it("sin globales: igual que antes (base + click)", () => {
    expect(buildDetalleFilter(base, {}, { mes: 3, rubroCodigo: "R1" }))
      .toEqual({ ...base, mes: 3, rubroCodigo: "R1" });
  });

  it("total anual con selección parcial de meses: manda esos meses", () => {
    expect(buildDetalleFilter(base, { activeMonths: [1, 2, 3] }, {}))
      .toEqual({ ...base, meses: [1, 2, 3] });
  });

  it("celda de un mes: gana el mes, no se mandan los meses activos", () => {
    const f = buildDetalleFilter(base, { activeMonths: [1, 2, 3] }, { mes: 2 });
    expect(f.mes).toBe(2);
    expect(f.meses).toBeUndefined();
  });

  it("arrastra los filtros globales al click del pie", () => {
    expect(buildDetalleFilter(base, { rubroCodigo: "R1", observacionQuery: "luz" }, { mes: 4 }))
      .toEqual({ ...base, mes: 4, rubroCodigo: "R1", observacionQuery: "luz" });
  });

  it("el concepto de la fila pisa el concepto global", () => {
    expect(buildDetalleFilter(base, { conceptoCodigo: "C1" }, { conceptoCodigo: "C2" }).conceptoCodigo).toBe("C2");
  });

  it("el rubro de la fila pisa el rubro global", () => {
    expect(buildDetalleFilter(base, { rubroCodigo: "R1" }, { rubroCodigo: "R2" }).rubroCodigo).toBe("R2");
  });

  it("proveedorId global se mantiene si el click no trae proveedor", () => {
    expect(buildDetalleFilter(base, { proveedorId: 9 }, { rubroCodigo: "R1" }).proveedorId).toBe(9);
  });

  it.each([
    [{ proveedorId: 5 }],
    [{ proveedorTexto: "Diego" }],
    [{ sinProveedor: true }],
  ])("si el click trae proveedor (%o), se descarta el proveedorId global", (extra) => {
    const f = buildDetalleFilter(base, { proveedorId: 9 }, extra);
    expect(f.proveedorId).toBe("proveedorId" in extra ? 5 : undefined);
  });

  it("click de un registro puntual (rowId): solo base + rowId/distribucionId, sin globales", () => {
    expect(buildDetalleFilter(base, { rubroCodigo: "R1", activeMonths: [1] }, { rowId: "abc", distribucionId: 7 }))
      .toEqual({ ...base, rowId: "abc", distribucionId: 7 });
  });
});
