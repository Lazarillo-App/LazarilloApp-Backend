// Portado de lazarillo_gestion/lib/impagas/aperturas.test.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { describe, it, expect } = require('../test-utils/vitest');
const { aCuenta, agruparEmpleados, modoDefault, porRubro, contarAntesDelCursor, cursorTrasSignificativos, disponibleOP, imputarElegidos, numeroOP, reimputar, formatearImporteAR, imputarFifo, importeAInput, normalizarReferencia, parsearImporteAR, porMes, rangoPorcentaje, saldoDeuda, textoParte } = require('./aperturas');

const mov = (key, fecha, importe, aplicado = 0) => ({
  key, fecha, comprobante: null, proveedor: "X", concepto: "", porcentaje: 50, importe, aplicado,
});

describe("imputar un pago a lo más viejo primero", () => {
  const movs = [mov("c", "2026-10-01", 300), mov("a", "2026-09-01", 100), mov("b", "2026-09-15", 200, 50)];
  it("menor que la deuda: el último queda parcial", () => {
    const r = imputarFifo(movs, 200);
    expect(r.aplicaciones).toEqual([{ key: "a", importe: 100 }, { key: "b", importe: 100 }]);
    expect(r.sobrante).toBe(0);
  });
  it("mayor que la deuda: el excedente queda a cuenta", () => {
    const r = imputarFifo(movs, 1000);
    expect(r.aplicaciones.map((x) => x.importe)).toEqual([100, 150, 300]);
    expect(r.sobrante).toBe(450);
  });
  it("respeta centavos", () => {
    expect(imputarFifo([mov("a", "2026-09-01", 10.1)], 10.05).aplicaciones[0].importe).toBe(10.05);
  });
});

describe("editar una orden de pago", () => {
  const movs = [mov("viejo", "2026-09-01", 100), mov("elegido", "2026-10-01", 200), mov("otro", "2026-10-05", 300)];
  it("primero vuelve a los mismos movimientos, después a lo más viejo, el resto a cuenta", () => {
    expect(reimputar(movs, ["elegido"], 150)).toEqual({ aplicaciones: [{ key: "elegido", importe: 150 }], sobrante: 0 });
    expect(reimputar(movs, ["elegido"], 350)).toEqual({
      aplicaciones: [{ key: "elegido", importe: 200 }, { key: "viejo", importe: 100 }, { key: "otro", importe: 50 }], sobrante: 0,
    });
    expect(reimputar(movs, ["elegido"], 700).sobrante).toBe(100);
  });
  it("número visible", () => expect(numeroOP(12)).toBe("OP 0012"));
});

describe("saldo de la deuda con el PDV", () => {
  it("resta lo imputado y lo que quedó a cuenta", () => {
    const d = {
      pdvOrigenId: 1,
      movimientos: [mov("a", "2026-09-01", 100, 100), mov("b", "2026-09-02", 200)],
      pagos: [{ id: 1, fecha: "2026-10-01", importe: 150, medio: "Caja Mayor", referencia: null, aplicado: 100, movimientos: 1 }],
    };
    expect(aCuenta(d)).toBe(50);
    expect(saldoDeuda(d)).toBe(150);
  });
  it("agrupa por mes", () => {
    const m = porMes([mov("b", "2026-10-02", 5), mov("a", "2026-09-30", 7, 2)]);
    expect(m.map((x) => [x.mes, x.total, x.saldo])).toEqual([["2026-10", 5, 5], ["2026-09", 7, 5]]);
  });
});

describe("sueldos agrupados por empleado dentro del mes", () => {
  it("junta los conceptos de cada empleado y deja el resto suelto", () => {
    const emp = (key, nombre, importe, aplicado = 0) =>
      ({ ...mov(key, "2026-10-21", importe, aplicado), proveedor: nombre, esEmpleado: true });
    const filas = agruparEmpleados([
      emp("1", "Lautaro Ruben Zuccala", 282630), mov("gv", "2026-10-16", 431351),
      emp("2", "Camila Cancino", 637190), emp("3", "Lautaro Ruben Zuccala", 35640, 35640),
    ]);
    expect(filas.map((f) => (f.tipo === "mov" ? f.mov.key : `${f.nombre}:${f.movimientos.length}`)))
      .toEqual(["Lautaro Ruben Zuccala:2", "gv", "Camila Cancino:1"]);
    const l = filas[0];
    expect(l.tipo === "empleado" && [l.total, l.saldo, l.aplicado]).toEqual([318270, 282630, 35640]);
  });
});

describe("pago sobre movimientos elegidos", () => {
  const movs = [mov("oct", "2026-10-05", 300), mov("sep1", "2026-09-01", 100), mov("sep2", "2026-09-20", 200, 50)];
  it("sin importe salda cada elegido por su saldo", () => {
    expect(imputarElegidos(movs, ["sep2", "sep1"])).toEqual({
      aplicaciones: [{ key: "sep1", importe: 100 }, { key: "sep2", importe: 150 }], sobrante: 0,
    });
  });
  it("importe menor: del más viejo al más nuevo, el último parcial", () => {
    expect(imputarElegidos(movs, ["sep1", "sep2"], 180).aplicaciones).toEqual([{ key: "sep1", importe: 100 }, { key: "sep2", importe: 80 }]);
  });
  it("importe mayor: el excedente queda a cuenta y no toca lo no elegido", () => {
    const r = imputarElegidos(movs, ["sep1"], 250);
    expect(r).toEqual({ aplicaciones: [{ key: "sep1", importe: 100 }], sobrante: 150 });
  });
  it("disponible de una OP", () => {
    expect(disponibleOP({ importe: 1300000, aplicado: 1150000 })).toBe(150000);
    expect(disponibleOP({ importe: 100, aplicado: 100 })).toBe(0);
  });
});

describe("el cursor no salta al final al editar el importe", () => {
  // Simula tipear: inserta en la posición y devuelve [texto formateado, cursor].
  const tipear = (valor, pos, txt) => {
    const crudo = valor.slice(0, pos) + txt + valor.slice(pos);
    const n = contarAntesDelCursor(crudo, pos + txt.length);
    const f = formatearImporteAR(crudo);
    return [f, cursorTrasSignificativos(f, n)];
  };
  const borrar = (valor, pos) => {
    const crudo = valor.slice(0, pos - 1) + valor.slice(pos);
    const f = formatearImporteAR(crudo);
    return [f, cursorTrasSignificativos(f, contarAntesDelCursor(crudo, pos - 1))];
  };
  it("cambiar un dígito del medio", () => {
    // "$ 1.150.000": borro el 5 (cursor después del 5) y escribo 2
    const [a, ca] = borrar("$ 1.150.000", 6);
    expect([a, ca]).toEqual(["$ 110.000", 4]);
    const [b, cb] = tipear(a, ca, "2");
    expect([b, cb]).toEqual(["$ 1.120.000", 6]);
  });
  it("agregar un dígito al principio corre bien los puntos", () => {
    expect(tipear("$ 150.000", 2, "1")).toEqual(["$ 1.150.000", 3]);
  });
  it("tipear al final sigue al final", () => {
    expect(tipear("$ 1.000", 7, "5")).toEqual(["$ 10.005", 8]);
  });
});

describe("importe en formato moneda e ID de transferencia", () => {
  it("formatea mientras se tipea y parsea de vuelta", () => {
    expect(formatearImporteAR("1234567")).toBe("$ 1.234.567");
    expect(formatearImporteAR("$ 1.234.567,895")).toBe("$ 1.234.567,89");
    expect(formatearImporteAR("0012,5")).toBe("$ 12,5");
    expect(parsearImporteAR("$ 1.234.567,89")).toBe(1234567.89);
    expect(parsearImporteAR("")).toBeNull();
    expect(importeAInput(32942565.4)).toBe("$ 32.942.565,40");
    expect(importeAInput(1000)).toBe("$ 1.000");
  });
  it("ID alfanumérico, largo, sin espacios", () => {
    expect(normalizarReferencia(" abc123 XYZ ")).toBe("ABC123XYZ");
    expect(normalizarReferencia("0000003100012345678901234")).toHaveLength(25);
    expect(normalizarReferencia("12-34")).toBeNull();
    expect(normalizarReferencia("")).toBeNull();
  });
});

describe("deuda con el PDV agrupada por rubro", () => {
  const m = (key, fecha, rubro, proveedor, concepto, importe, esEmpleado = false, aplicado = 0) =>
    ({ key, fecha, comprobante: null, proveedor, concepto, porcentaje: 50, importe, aplicado, rubro, esEmpleado });
  const movs = [
    m("s1", "2026-10-05", "Gastos En Personal", "Camila Cancino", "Liquidacion", 100, true),
    m("s2", "2026-10-20", "Gastos En Personal", "Camila Cancino", "Presentismo", 20, true),
    m("af", "2026-10-10", "Gastos En Personal", "AFIP", "Cargas Sociales Afip", 300),
    m("e1", "2026-09-01", "Servicios", "Edenor", "Energia", 50),
    m("e2", "2026-10-01", "Servicios", "Edenor", "Energia", 60, false, 60),
    m("w1", "2026-10-02", "Servicios", "Meta", "Api - Whatsapp", 40),
  ];
  it("defaults: Personal por empleado, el resto por concepto", () => {
    expect(modoDefault("Gastos En Personal")).toBe("empleado");
    expect(modoDefault("Servicios")).toBe("concepto");
    const r = porRubro(movs);
    expect(r.map((x) => [x.rubro, x.saldo])).toEqual([["Gastos En Personal", 420], ["Servicios", 90]]);
    const per = r[0];
    expect(per.grupos.map((g) => [g.clave, g.saldo, g.esEmpleado])).toEqual([["Cargas Sociales Afip", 300, false], ["Camila Cancino", 120, true]]);
    expect(per.grupos[1].movimientos.map((x) => x.key)).toEqual(["s2", "s1"]); // más nuevo primero
  });
  it("cada rubro se puede ver por proveedor", () => {
    const r = porRubro(movs, { Servicios: "proveedor" });
    const sv = r.find((x) => x.rubro === "Servicios");
    expect(sv.modo).toBe("proveedor");
    expect(sv.grupos.map((g) => [g.clave, g.total, g.saldo])).toEqual([["Edenor", 110, 50], ["Meta", 40, 40]]);
  });
});

describe("porcentaje de apertura en grupos y tooltip", () => {
  it("un % o un rango", () => {
    expect(rangoPorcentaje([{ porcentaje: 15 }, { porcentaje: 15 }])).toBe("15%");
    expect(rangoPorcentaje([{ porcentaje: 15 }, { porcentaje: 10 }, { porcentaje: 12.5 }])).toBe("10–15%");
    expect(rangoPorcentaje([{ porcentaje: 33.333 }])).toBe("33,3%");
    expect(rangoPorcentaje([])).toBeNull();
  });
  it("parte sobre el total", () => {
    const f = (n) => `$${n}`;
    expect(textoParte({ importe: 108000, totalCompra: 700000, porcentaje: 15.43 }, f)).toBe("$108000 de $700000 (15,4%)");
    expect(textoParte({ importe: 50, porcentaje: 50 }, f)).toBe("$50 (50%)");
  });
});
