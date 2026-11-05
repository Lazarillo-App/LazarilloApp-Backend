// Portado de lazarillo_gestion/lib/impagas/clasificar.test.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { describe, it, expect } = require('../test-utils/vitest');
const { agrupar, dias, filtrar, fmtComprobante, motivo, separar, saldo } = require('./clasificar');

function cpb(o = {}) {
  return {
    id: "1|A000300076701|165", pdvId: 1, comprobante: "A000300076701", codPro: "165",
    proveedor: "Pehuenia", proveedorId: 7, fecha: "2026-09-01", total: 1000, pagado: 0,
    rubroOculto: null, pagoAutomatico: false, forzada: false, conceptos: "", pagos: [], ...o,
  };
}

describe("motivo de exclusión", () => {
  it("factura común → impaga", () => expect(motivo(cpb())).toBeNull());
  it("rubro oculto, pago automático y nota de crédito → excluidas", () => {
    expect(motivo(cpb({ rubroOculto: "Iva Compra" }))).toBe("rubro");
    expect(motivo(cpb({ pagoAutomatico: true }))).toBe("auto");
    expect(motivo(cpb({ comprobante: "N000600095048", total: -500 }))).toBe("nc");
  });
  it("pasada a mano a impagas le gana a cualquier motivo", () => {
    expect(motivo(cpb({ rubroOculto: "Iva Compra", pagoAutomatico: true, forzada: true }))).toBeNull();
  });
  it("tickets Z entran como cualquier factura (Alquiler)", () => {
    expect(motivo(cpb({ comprobante: "Z114504012025" }))).toBeNull();
  });
});

describe("separar / agrupar / filtrar", () => {
  const hoy = new Date(2026, 9, 22);
  const lista = [
    cpb({ id: "a", codPro: "1", proveedor: "Coca Cola", fecha: "2026-10-01", total: 300 }),
    cpb({ id: "b", codPro: "1", proveedor: "Coca Cola", fecha: "2026-03-01", total: 200, pagado: 50 }),
    cpb({ id: "c", codPro: "2", proveedor: "Alquiler", comprobante: "Z000100000077", fecha: "2026-09-15", total: 900 }),
    cpb({ id: "d", codPro: "3", proveedor: "Agronatural", rubroOculto: "Iva Compra", total: 99 }),
  ];
  it("separa impagas de excluidas", () => {
    const { impagas, excluidas } = separar(lista);
    expect(impagas.map((f) => f.id)).toEqual(["a", "b", "c"]);
    expect(excluidas.map((f) => f.id)).toEqual(["d"]);
  });
  it("agrupa por proveedor con saldo y la más vieja primero", () => {
    const g = agrupar(separar(lista).impagas, "saldo");
    expect(g.map((x) => x.proveedor)).toEqual(["Alquiler", "Coca Cola"]);
    expect(g[1].saldo).toBe(450);
    expect(g[1].items[0].id).toBe("a"); // la más nueva primero
    expect(g[1].masVieja).toBe("2026-03-01");
    expect(agrupar(separar(lista).impagas, "antiguedad")[0].proveedor).toBe("Coca Cola");
    expect(agrupar(separar(lista).impagas, "antiguedad", "asc")[0].proveedor).toBe("Alquiler");
    expect(agrupar(separar(lista).impagas, "saldo", "asc")[0].proveedor).toBe("Coca Cola");
  });
  it("busca por proveedor o comprobante sin importar espacios/guiones, y filtra 0–60 días", () => {
    expect(filtrar(lista, { q: "coca cola", solo60: false, hoy }).length).toBe(2);
    expect(filtrar(lista, { q: "Z 0001-00000077", solo60: false, hoy }).map((f) => f.id)).toEqual(["c"]);
    expect(filtrar(lista, { q: "", solo60: true, hoy }).map((f) => f.id)).toEqual(["a", "c", "d"]);
  });
  it("tolera tipeo: acentos, mayúsculas y letras dobles", () => {
    const l = [cpb({ id: "z", proveedor: "Lautaro Ruben Zuccala" }), cpb({ id: "n", proveedor: "Alejo Nuñez" })];
    expect(filtrar(l, { q: "zucala", solo60: false, hoy }).map((f) => f.id)).toEqual(["z"]);
    expect(filtrar(l, { q: "NUNEZ", solo60: false, hoy }).map((f) => f.id)).toEqual(["n"]);
  });
  it("saldo y días", () => {
    expect(saldo(cpb({ total: 1000, pagado: 400 }))).toBe(600);
    expect(dias("2026-10-01", hoy)).toBe(21);
  });
  it("formato de comprobante", () => {
    expect(fmtComprobante("A000300076701")).toBe("A 0003-00076701");
    expect(fmtComprobante("NC114008072025")).toBe("NC 1140-08072025");
  });
});
