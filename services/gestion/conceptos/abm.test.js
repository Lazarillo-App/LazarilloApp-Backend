// Portado de lazarillo_gestion/lib/conceptos/abm.test.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { describe, it, expect } = require('../test-utils/vitest');
const { proximoCodigoLazarillo, esPropio, conceptoPropioSchema, etiquetaTipo } = require('./abm');

describe("conceptos propios", () => {
  it("el primero es 1000 y después sigue el máximo", () => {
    expect(proximoCodigoLazarillo([1, 2, 999])).toBe(1000);
    expect(proximoCodigoLazarillo(["1000", "1003", "50"])).toBe(1004);
  });
  it("solo desde 1000 son de Lazarillo", () => {
    expect(esPropio(999)).toBe(false);
    expect(esPropio("1000")).toBe(true);
  });
  it("valida el alta", () => {
    expect(conceptoPropioSchema.safeParse({ nombre: " Inflable Reloj ", tipo: "-", codRubro: "31" }).data).toEqual({ nombre: "Inflable Reloj", tipo: "-", codRubro: "31" });
    expect(conceptoPropioSchema.safeParse({ codigo: 999, nombre: "x", tipo: "-", codRubro: "1" }).success).toBe(false);
    expect(conceptoPropioSchema.safeParse({ nombre: "", tipo: "-", codRubro: "1" }).success).toBe(false);
    expect(etiquetaTipo("E")).toBe("Empleados");
  });
});
