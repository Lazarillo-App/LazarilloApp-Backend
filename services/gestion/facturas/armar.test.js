// Portado de lazarillo_gestion/lib/facturas/armar.test.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { describe, it, expect } = require('../test-utils/vitest');
const { armarFactura, facturaSchema, comprobanteDe } = require('./armar');
const { parseComprobanteFromDetalle } = require('../etl/normalizers/compra-identity');

// Factura real: Distribuidora El Criollo, A 0008-00045204 del 22/09/2026 (Bar).
// Cargada en Lazarillo con los mismos registros del 25 tiene que dar las mismas
// filas del 14 que trajo MaxiRest.
const L = [
  ["356", "Ketchup Hellmans 8gr", "CAJA", 2, 24732.2, 21, "1"], ["467", "Pimienta Blanca Molida", "K", 1, 13392, 21, "67"],
  ["906", "Leche Condensada", "L", 1.58, 15692.72, 21, "3"], ["412", "Humo Liquido", "L", 1, 11640.29, 21, "1"],
  ["80", "Pan Rallado Preferido", "K", 10, 21958, 21, "1"], ["351", "Copos De Maiz", "K", 3, 12914.23, 21, "1"],
  ["568", "Mani Salado", "K", 7, 32479.65, 21, "1"], ["512", "Mayonesa Natura 8gr", "CAJA", 3, 38157.48, 21, "1"],
  ["482", "Azucar Negra", "K", 1, 1543.81, 21, "1"], ["518", "Mostaza Savora 8 Gr", "CAJA", 1, 10975.62, 21, "1"],
  ["1972", "Maiz Pizingallo", "K", 5, 3794.65, 10.5, "1"], ["337", "Vinagre Blanco Silva", "L", 5, 3219.05, 21, "1"],
  ["409", "Pure De Tomate Mk", "L", 12, 17612.64, 21, "1"], ["681", "Maicena", "K", 2, 3845.02, 21, "67"],
  ["519", "Papas Pay", "K", 0.8, 9983.2, 21, "1"], ["1670", "Rebozador Preferido", "K", 10, 21958, 21, "1"],
  ["72", "Harina 000", "K", 50, 47151, 10.5, "1"], ["551", "Azucar Impalpable", "K", 5, 7439.74, 21, "10"],
  ["885", "Salsa Dulce De Leche", "K", 0.5, 3137.13, 21, "1"], ["516", "Oregano", "K", 1, 5913, 21, "67"],
];
const ctx = {
  proveedor: { id: 92, codigo: "92" },
  pdvs: [{ id: 1, localId: 1 }, { id: 2, localId: 1 }],
  conceptos: [{ codigo: "1", nombre: "Almacen" }, { codigo: "3", nombre: "Lacteos" }, { codigo: "10", nombre: "Cafeteria Pasteleria" },
    { codigo: "67", nombre: "Especias" }, { codigo: "133", nombre: "Percepcion Iva" }, { codigo: "899", nombre: "Ib Percepcion" }],
};
const factura = facturaSchema.parse({
  proveedorId: 92, tipo: "FcA", prefijo: "8", numero: "45204", fecha: "2026-09-22",
  registros: L.map(([cod, nom, med, cant, neto, alic, cga]) => ({ tipo: "insumo", insumoCodigo: cod, nombre: nom, medida: med, cantidad: cant, neto, alicuota: alic, conceptoCodigo: cga, puntoDeVentaId: 1 })),
  percepciones: [{ tipo: "Perc. IVA RG 3337", importe: 9226.17 }, { tipo: "Perc. IIBB PBA", importe: 0.01 }],
});

describe("armarFactura", () => {
  it("da las mismas filas del 14 que MaxiRest (El Criollo A 0008-00045204)", () => {
    const { filas, lineas, total } = armarFactura(factura, ctx);
    const por = Object.fromEntries(filas.map((x) => [x.codCga, x.importe]));
    expect(por).toEqual({ "1": 310771.61, "67": 28011.52, "3": 18988.19, "10": 9002.09, "133": 9226.17, "899": 0.01 });
    expect(total).toBe(375999.59); // suma de las 6 filas del 14 real
    expect(lineas).toHaveLength(20);
    expect(filas[0].comprobante).toBe("A000800045204");
    // El DETALLE tiene el formato del kit y el ETL lo lee como el mismo comprobante.
    expect(parseComprobanteFromDetalle(filas[0].detalle)).toBe("A000800045204");
    expect(filas.every((x) => !x.esBloqueado)).toBe(true);
  });
  it("reparto por PDV: una fila por PDV, suma exacta y no la vuelve a repartir la apertura", () => {
    const f = facturaSchema.parse({ ...factura, percepciones: [], registros: [{ tipo: "concepto", conceptoCodigo: "1", nombre: "Almacen", neto: 1000, alicuota: 21, puntoDeVentaId: 1, reparto: [{ puntoDeVentaId: 1, pct: 60 }, { puntoDeVentaId: 2, pct: 40 }] }] });
    const { filas, lineas } = armarFactura(f, ctx);
    expect(filas.map((x) => [x.puntoDeVentaId, x.importe])).toEqual([[1, 726], [2, 484]]);
    expect(filas.every((x) => x.esBloqueado)).toBe(true);
    expect(lineas.map((l) => l.medida)).toEqual([null, null]);
  });
  it("nota de crédito: importes en negativo, como en el 14", () => {
    const f = facturaSchema.parse({ ...factura, tipo: "NC-A", percepciones: [], registros: [{ tipo: "concepto", conceptoCodigo: "1", nombre: "Almacen", neto: 100, alicuota: 21, puntoDeVentaId: 1 }] });
    const { filas } = armarFactura(f, ctx);
    expect(filas[0].importe).toBe(-121);
    expect(filas[0].comprobante.startsWith("NC")).toBe(true);
  });
  it("insumo bonificado (importe 0): va al detalle con su cantidad y sin fila propia en el 14", () => {
    const f = facturaSchema.parse({ ...factura, percepciones: [], registros: [
      { tipo: "insumo", insumoCodigo: "72", nombre: "Harina 000", medida: "K", cantidad: 25, neto: 0, alicuota: 10.5, conceptoCodigo: "10", puntoDeVentaId: 1 },
      { tipo: "insumo", insumoCodigo: "906", nombre: "Leche Condensada", medida: "L", cantidad: 2, neto: 1000, alicuota: 21, conceptoCodigo: "3", puntoDeVentaId: 1 },
    ] });
    const { filas, lineas, total } = armarFactura(f, ctx);
    expect(filas.map((x) => x.codCga)).toEqual(["3"]);
    expect(total).toBe(1210);
    expect(lineas[0]).toMatchObject({ cantidad: 25, totalIns: 0, neto: 0, compraId: null });
    expect(lineas[1].compraId).toBe(filas[0].rowId);
  });
  it("rechaza reparto que no suma 100 y fechas inexistentes", () => {
    const base = { proveedorId: 92, tipo: "FcA", prefijo: "1", numero: "1", registros: [{ tipo: "concepto", conceptoCodigo: "1", nombre: "A", neto: 10, alicuota: 21, puntoDeVentaId: 1, reparto: [{ puntoDeVentaId: 1, pct: 60 }, { puntoDeVentaId: 2, pct: 30 }] }] };
    expect(facturaSchema.safeParse({ ...base, fecha: "2026-10-27" }).success).toBe(false);
    expect(facturaSchema.safeParse({ ...base, fecha: "2026-02-31", registros: [{ ...base.registros[0], reparto: null }] }).success).toBe(false);
    expect(facturaSchema.safeParse({ ...base, fecha: "2026-02-28", registros: [{ ...base.registros[0], reparto: null }] }).success).toBe(true);
  });
  it("comprobante con ceros a la izquierda", () => {
    expect(comprobanteDe("Ticket", "12", "5").detalle).toBe("Tic 0012-00000005");
  });
});
