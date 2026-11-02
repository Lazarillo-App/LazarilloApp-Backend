// Portado de lazarillo_gestion/lib/etl/normalizers/proveedor-match.test.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { describe, it, expect } = require('../../test-utils/vitest');
const { proveedorTextoCoincide, resolveProveedorId } = require('./proveedor-match');

describe("proveedorTextoCoincide", () => {
  it("texto crudo coincide exacto con nombre (case/espacios distintos) → true", () => {
    expect(proveedorTextoCoincide("WALDMAN DIEGO MARTIN", { nombre: "Waldman Diego Martin", razon: null })).toBe(true);
  });

  it("texto crudo coincide con puntuación distinta ('/' vs espacio) → true", () => {
    expect(proveedorTextoCoincide("Compra Ocasional / ML", { nombre: "Compra Ocasional Ml", razon: null })).toBe(true);
  });

  it("texto crudo coincide solo con razon, no con nombre → true", () => {
    expect(proveedorTextoCoincide("Juan Perez SRL", { nombre: "Distinto", razon: "Juan Perez SRL" })).toBe(true);
  });

  it("texto crudo no coincide con nombre ni razon → false", () => {
    expect(proveedorTextoCoincide("Diego", { nombre: "Creacion Tm Sr", razon: null })).toBe(false);
  });

  it("placeholder genérico no coincide con un proveedor real → false", () => {
    expect(proveedorTextoCoincide("GASTOS VARIOS", { nombre: "Prosegur", razon: null })).toBe(false);
  });

  it("acentos en el texto crudo pero no en el maestro → true (se transliteran, no se descartan)", () => {
    expect(proveedorTextoCoincide("Agustín Pérez", { nombre: "Agustin Perez", razon: null })).toBe(true);
  });

  it("acentos en el maestro pero no en el texto crudo → true (simétrico)", () => {
    expect(proveedorTextoCoincide("Agustin Perez", { nombre: "Agustín Pérez", razon: null })).toBe(true);
  });

  it("acentos distintos no vuelven iguales a dos proveedores distintos → false", () => {
    expect(proveedorTextoCoincide("Agustín", { nombre: "Creación Tm Sr", razon: null })).toBe(false);
  });

  it("ñ y diéresis se transliteran igual en ambos lados → true", () => {
    expect(proveedorTextoCoincide("Diseños Nuñez", { nombre: "Disenos Nunez", razon: null })).toBe(true);
  });

  it("texto crudo null: sin evidencia en contra, se confía en el candidato → true", () => {
    expect(proveedorTextoCoincide(null, { nombre: "Cualquiera", razon: null })).toBe(true);
  });

  it("candidato sin nombre ni razon y texto presente → false", () => {
    expect(proveedorTextoCoincide("Diego", { nombre: null, razon: null })).toBe(false);
  });
});

describe("resolveProveedorId", () => {
  const provMap = new Map ([
    ["309", { id: 46893, nombre: "Creacion Tm Sr", razon: null }],
    ["3649", { id: 47512, nombre: "Waldman Diego Martin", razon: null }],
  ]);

  it("CODIGO sin match en el maestro → null", () => {
    expect(resolveProveedorId("NOEXISTE", "Cualquiera", provMap)).toBeNull();
  });

  it("CODIGO null → null", () => {
    expect(resolveProveedorId(null, "Cualquiera", provMap)).toBeNull();
  });

  it("caso real de regresión: CODIGO 309 coincide con 'Creacion Tm Sr' pero el texto es 'Diego' → null", () => {
    expect(resolveProveedorId("309", "Diego", provMap)).toBeNull();
  });

  it("CODIGO 3649 con texto 'WALDMAN DIEGO MARTIN' → resuelve al id real", () => {
    expect(resolveProveedorId("3649", "WALDMAN DIEGO MARTIN", provMap)).toBe(47512);
  });
});
