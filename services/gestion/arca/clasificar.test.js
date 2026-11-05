// Portado de lazarillo_gestion/lib/arca/clasificar.test.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { describe, it, expect } = require('../test-utils/vitest');
const { clasificar } = require('./clasificar');

const a = (p) => ({ key: "k", cuit: "30716842300", emisor: "VIDA LACTEA", tipo: 1, puntoVenta: 1, numero: 25466, fecha: "2025-02-17", total: 288257.62, otros: 0, nc: false, proveedorId: 9, proveedor: "Vida Láctea", cargados: [], ...p });
const c = (t, cp = "FCA000100025466", l = 1, f = "2025-02-17") => ({ comprobante: cp, localId: l, total: t, fecha: f, rowId: cp + l });

describe("cruce ARCA", () => {
  it("igual, o igual sin la percepción", () => {
    const r = clasificar([a({ cargados: [c(288258)] }), a({ key: "2", total: 1000, otros: 50, cargados: [c(950)] })], []);
    expect(r.ok).toBe(2); expect(r.corregir).toHaveLength(0);
  });
  it("falta y otro número", () => {
    const r = clasificar([a({}), a({ key: "x", numero: 99, total: 5000 })], [{ cuit: "30716842300", comprobante: "FCA000100025465", localId: 1, total: 288257.62, fecha: "2025-02-17", rowId: "r1" }]);
    expect(r.corregir.map((x) => x.motivo)).toEqual(["numero"]);
    expect(r.faltan.map((x) => x.numero)).toEqual([99]);
  });
  it("duplicado A… y FCA…", () => {
    const r = clasificar([a({ total: 505359.16, cargados: [c(505359, "A000200000224"), c(505359, "FCA000200000224")] })], []);
    expect(r.corregir[0].motivo).toBe("duplicado");
  });
  it("importe distinto y fecha distinta", () => {
    const r = clasificar([a({ total: 1104213.76, cargados: [c(651148)] }), a({ key: "f", cargados: [c(288257.62, "FCA000100025466", 1, "2025-03-20")] })], []);
    expect(r.corregir.map((x) => x.motivo)).toEqual(["importe", "fecha"]);
  });
  it("repartida en 2 locales: vale si un local coincide", () => {
    const r = clasificar([a({ total: 373172.16, cargados: [c(373172, "A060608423466", 1), c(373172, "A060608423466", 2)] })], []);
    expect(r.ok).toBe(1);
  });
});

describe("factura + NC que se anulan", () => {
  it("mismo CUIT y mismo importe, ninguna cargada: no se muestran", async () => {
    const { sacarAnuladas } = require("./clasificar");
    const a = (key, nc, total, fecha, cuit = "20") => ({ key, cuit, emisor: null, tipo: nc ? 3 : 1, puntoVenta: 6, numero: 1, fecha, total, otros: 0, nc, proveedorId: null, proveedor: null, cargados: [] });
    const r = sacarAnuladas([a("f1", false, 202976, "2026-09-08"), a("n1", true, 202976, "2026-09-08"), a("f2", false, 5000, "2026-09-01"), a("n2", true, 7000, "2026-09-02")]);
    expect(r.anuladas).toHaveLength(1);
    expect(r.faltan.map((x) => x.key)).toEqual(["f2", "n2"]);
  });
});
