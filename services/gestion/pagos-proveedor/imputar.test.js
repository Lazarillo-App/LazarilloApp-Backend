// Portado de lazarillo_gestion/lib/pagos-proveedor/imputar.test.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { describe, it, expect } = require('../test-utils/vitest');
const { combinarPagos, imputarFacturas, recortarAplicaciones } = require('./imputar');

describe("recortarAplicaciones", () => {
  const apl = [{ id: 1, fecha: "2026-10-01", importe: 147621.46 }, { id: 2, fecha: "2026-10-09", importe: 410879.14 }];
  it("si alcanza, no toca nada", () => {
    expect(recortarAplicaciones(apl, 600000)).toEqual([{ id: 1, importe: 147621.46 }, { id: 2, importe: 410879.14 }]);
  });
  it("si no alcanza, suelta primero lo de la factura más nueva", () => {
    expect(recortarAplicaciones(apl, 500000)).toEqual([{ id: 1, importe: 147621.46 }, { id: 2, importe: 352378.54 }]);
    expect(recortarAplicaciones(apl, 100000)).toEqual([{ id: 1, importe: 100000 }, { id: 2, importe: 0 }]);
  });
});

describe("combinarPagos", () => {
  const p = (fecha, importe) => ({ fecha, importe });
  it("solo 80 o solo Lazarillo: se suman", () => {
    expect(combinarPagos([p("2026-10-05", 1000)], [], 1000)).toEqual({ pagado: 1000, conciliados: [], deMas: false });
    expect(combinarPagos([], [p("2026-10-05", 400)], 1000)).toEqual({ pagado: 400, conciliados: [], deMas: false });
  });
  it("el mismo pago en el 80 y en Lazarillo (importe y fecha cercana): una sola vez", () => {
    expect(combinarPagos([p("2026-10-05", 1000)], [p("2026-10-07", 1000.5)], 1000)).toEqual({ pagado: 1000, conciliados: [0], deMas: false });
  });
  it("pago parcial en el 80 y el resto en Lazarillo por el mismo importe pero otra fecha: se suman", () => {
    expect(combinarPagos([p("2026-09-01", 500)], [p("2026-10-20", 500)], 1000)).toEqual({ pagado: 1000, conciliados: [], deMas: false });
  });
  it("si pasan el total, de más", () => {
    expect(combinarPagos([p("2026-10-01", 800)], [p("2026-10-02", 400)], 1000)).toEqual({ pagado: 1200, conciliados: [], deMas: true });
  });
});

describe("imputarFacturas", () => {
  const fs = [
    { key: "1|B", fecha: "2026-10-09", saldo: 410879.14 },
    { key: "1|A", fecha: "2026-10-01", saldo: 147621.46 },
    { key: "1|P", fecha: "2026-09-01", saldo: 0 },
  ];
  it("sin importe salda cada una entera", () => {
    expect(imputarFacturas(fs)).toEqual({ aplicaciones: [{ key: "1|A", importe: 147621.46 }, { key: "1|B", importe: 410879.14 }], sobrante: 0 });
  });
  it("de más: el excedente queda a cuenta", () => {
    const r = imputarFacturas(fs, 600000);
    expect(r.aplicaciones.map((a) => a.importe)).toEqual([147621.46, 410879.14]);
    expect(r.sobrante).toBe(41499.4);
  });
  it("de menos: la más vieja primero, la última queda parcial", () => {
    expect(imputarFacturas(fs, 200000).aplicaciones).toEqual([{ key: "1|A", importe: 147621.46 }, { key: "1|B", importe: 52378.54 }]);
  });
});
