// Portado de lazarillo_gestion/lib/empleados/carga.test.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { describe, it, expect } = require('../test-utils/vitest');
const { cargaEmpleadoSchema, filasEmpleado, validarSueldo, MEDIO_ADELANTOS } = require('./carga');

const sueldo = (extra = {}) => ({
  tipo: "sueldo", pdvId: 1, codigo: "608", periodo: "2026-09", fechaPago: "2026-10-10", total: 1250000,
  conceptos: [
    { conceptoCodigo: "301", importe: 900000, pagos: [{ medio: "Transferencia", importe: 500000 }, { medio: "Efectivo", importe: 300000 }, { medio: MEDIO_ADELANTOS, importe: 100000 }] },
    { conceptoCodigo: "953", importe: 350000, pagos: [{ medio: "Efectivo", importe: 350000 }] },
  ],
  ...extra,
});

describe("validarSueldo", () => {
  it("cierra: conceptos = total, pagos = concepto, adelantos descontados", () => {
    expect(validarSueldo(sueldo(), 100000)).toEqual([]);
  });
  it("conceptos que no suman el total", () => {
    expect(validarSueldo(sueldo({ total: 1300000 }), 100000)[0]).toContain("tienen que dar exacto");
  });
  it("formas de pago que no suman el concepto", () => {
    const s = sueldo();
    s.conceptos[1].pagos[0].importe = 300000;
    expect(validarSueldo(s, 100000).some((x) => x.includes("Concepto 2"))).toBe(true);
  });
  it("adelantos del período sin descontar, o descontados sin haber", () => {
    expect(validarSueldo(sueldo(), 150000).some((x) => x.includes("tienen que descontarse"))).toBe(true);
    expect(validarSueldo(sueldo(), 0).some((x) => x.includes("No hay adelantos"))).toBe(true);
  });
  it("reparto que no suma 100", () => {
    expect(validarSueldo(sueldo({ reparto: [{ puntoDeVentaId: 1, pct: 60 }, { puntoDeVentaId: 3, pct: 30 }] }), 100000)).toContain("El reparto por PDV tiene que sumar 100%.");
  });
});

describe("filasEmpleado", () => {
  it("una fila por concepto × forma de pago, sin la de adelantos", () => {
    const f = filasEmpleado(7, sueldo());
    expect(f.map((x) => [x.conceptoCodigo, x.medio, x.importe])).toEqual([["301", "Transferencia", 500000], ["301", "Efectivo", 300000], ["953", "Efectivo", 350000]]);
    expect(f.every((x) => x.puntoDeVentaId === 1 && !x.bloqueada)).toBe(true);
    expect(f[0].rowId).toBe("emp-7-0-0");
  });
  it("con reparto: cada fila se parte por PDV, suma exacta y bloqueada", () => {
    const f = filasEmpleado(7, sueldo({ reparto: [{ puntoDeVentaId: 1, pct: 60 }, { puntoDeVentaId: 3, pct: 40 }] }));
    expect(f).toHaveLength(6);
    expect(f.filter((x) => x.medio === "Efectivo" && x.conceptoCodigo === "953").map((x) => x.importe)).toEqual([210000, 140000]);
    expect(f.every((x) => x.bloqueada)).toBe(true);
    expect(Math.round(f.reduce((s, x) => s + x.importe, 0))).toBe(1150000);
  });
  it("adelanto: una fila con su medio", () => {
    const a = cargaEmpleadoSchema.parse({ tipo: "adelanto", pdvId: 1, codigo: "608", periodo: "2026-10", fechaPago: "2026-10-08", importe: 80000, medio: "Efectivo" });
    expect(filasEmpleado(9, a)).toEqual([{ rowId: "emp-9-0-0", puntoDeVentaId: 1, conceptoCodigo: "", medio: "Efectivo", importe: 80000, bloqueada: false }]);
  });
});
