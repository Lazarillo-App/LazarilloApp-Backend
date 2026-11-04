// Portado de lazarillo_gestion/lib/facturas/leer.test.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { describe, it, expect } = require('../test-utils/vitest');
const { armarFactura, facturaSchema } = require('./armar');
const { facturaDesdeFilas, tipoDeComprobante } = require('./leer');

const ctx = {
  proveedor: { id: 92, codigo: "92" },
  pdvs: [{ id: 1, localId: 1 }, { id: 2, localId: 1 }],
  conceptos: [{ codigo: "1", nombre: "Almacen" }, { codigo: "3", nombre: "Lacteos" }, { codigo: "133", nombre: "Percepcion Iva" }, { codigo: "899", nombre: "Ib Percepcion" }],
};
const f = facturaSchema.parse({
  proveedorId: 92, tipo: "FcA", prefijo: "8", numero: "45204", fecha: "2026-09-22", observacion: "x",
  registros: [
    { tipo: "insumo", insumoCodigo: "72", nombre: "Harina 000", medida: "K", cantidad: 50, neto: 47151, alicuota: 10.5, conceptoCodigo: "1", puntoDeVentaId: 1 },
    { tipo: "insumo", insumoCodigo: "906", nombre: "Leche Condensada", medida: "L", cantidad: 1.58, neto: 15692.72, alicuota: 21, conceptoCodigo: "3", puntoDeVentaId: 1, impInt: 10 },
    { tipo: "concepto", conceptoCodigo: "1", nombre: "Almacen", neto: 500, alicuota: 21, puntoDeVentaId: 2 },
  ],
  percepciones: [{ tipo: "Perc. IVA RG 3337", importe: 9226.17 }, { tipo: "Perc. IIBB PBA", importe: 1500 }],
});

describe("facturaDesdeFilas", () => {
  it("rearma lo cargado: volver a armarla da las mismas filas del 14", () => {
    const a = armarFactura(f, ctx);
    const filas = a.filas.map((x) => ({ rowId: x.rowId, comprobante: x.comprobante, codCga: x.codCga, fecha: x.fecha, observac: x.observac, importe: x.importe, impInt: x.impInt, puntoDeVentaId: x.puntoDeVentaId }));
    const lineas = a.lineas.map((l) => ({ codigo: l.codigo, nombre: l.nombre, medida: l.medida, cantidad: l.cantidad, totalIns: l.totalIns, tasa: l.tasa, impNtTot: l.impNtTot, codCga: l.codCga, compraId: l.compraId }));
    const { factura, estimado, totalFilas } = facturaDesdeFilas(92, filas, lineas);
    expect(estimado).toBe(false);
    expect(factura).toMatchObject({ tipo: "FcA", prefijo: "0008", numero: "00045204", fecha: "2026-09-22", observacion: "x" });
    expect(factura.registros.map((r) => [r.tipo, r.conceptoCodigo, r.puntoDeVentaId, r.neto])).toEqual([["insumo", "1", 1, 47151], ["insumo", "3", 1, 15692.72], ["concepto", "1", 2, 500]]);
    const b = armarFactura(factura, ctx);
    expect(b.filas.map((x) => [x.rowId, x.importe])).toEqual(a.filas.map((x) => [x.rowId, x.importe]));
    expect(totalFilas).toBe(a.total);
  });
  it("sin detalle del 25: un concepto por fila y percepciones aparte", () => {
    const { factura, estimado } = facturaDesdeFilas(5, [
      { rowId: "a", comprobante: "Z000100000077", codCga: "40", fecha: "2026-10-01", observac: null, importe: 1210, impInt: 0, puntoDeVentaId: 3 },
      { rowId: "b", comprobante: "Z000100000077", codCga: "899", fecha: "2026-10-01", observac: null, importe: 50, impInt: 0, puntoDeVentaId: 3 },
    ], []);
    expect(estimado).toBe(true);
    expect(factura.tipo).toBe("Ticket");
    expect(factura.registros).toEqual([expect.objectContaining({ tipo: "concepto", conceptoCodigo: "40", neto: 1000, alicuota: 21, puntoDeVentaId: 3 })]);
    expect(factura.percepciones).toEqual([{ tipo: "Perc. IIBB PBA", importe: 50 }]);
  });
  it("tipo por la letra del comprobante", () => {
    expect(["NC000100000001", "B0001", "C1", "A1", "Z1"].map(tipoDeComprobante)).toEqual(["NC-A", "FcB", "FcC", "FcA", "Ticket"]);
  });
});
