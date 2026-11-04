// Portado de lazarillo_gestion/lib/apertura/calculo.test.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { describe, it, expect } = require('../test-utils/vitest');
const { calcularDistribuciones } = require('./calculo');

describe("calcularDistribuciones", () => {
  it("divide 50/50 sin resto ($1.000.000 -> $500.000/$500.000, fixture CA-01 de la spec)", () => {
    const result = calcularDistribuciones(1000000, [
      { id: 1, porcentaje: 50 },
      { id: 2, porcentaje: 50 },
    ]);
    expect(result).toEqual([
      { destinoId: 1, importeCalculado: 500000 },
      { destinoId: 2, importeCalculado: 500000 },
    ]);
  });

  it("recalcula sobre el nuevo importe al reimportar ($1.200.000 -> $600.000/$600.000, fixture CA-02)", () => {
    const result = calcularDistribuciones(1200000, [
      { id: 1, porcentaje: 50 },
      { id: 2, porcentaje: 50 },
    ]);
    expect(result).toEqual([
      { destinoId: 1, importeCalculado: 600000 },
      { destinoId: 2, importeCalculado: 600000 },
    ]);
  });

  it("reparto no exacto (33/33/34): el último destino se lleva el resto, la suma da exacto", () => {
    const result = calcularDistribuciones(100, [
      { id: 1, porcentaje: 33 },
      { id: 2, porcentaje: 33 },
      { id: 3, porcentaje: 34 },
    ]);
    expect(result).toEqual([
      { destinoId: 1, importeCalculado: 33 },
      { destinoId: 2, importeCalculado: 33 },
      { destinoId: 3, importeCalculado: 34 },
    ]);
  });

  it("importe con centavos no exactamente divisible: la suma da el total exacto (invariante no negociable)", () => {
    const result = calcularDistribuciones(100.01, [
      { id: 1, porcentaje: 33.33 },
      { id: 2, porcentaje: 33.33 },
      { id: 3, porcentaje: 33.34 },
    ]);
    const suma = result.reduce((acc, d) => acc + d.importeCalculado, 0);
    expect(Math.round(suma * 100) / 100).toBe(100.01);
  });

  it("es determinístico: ordena por id de destino sin importar el orden de entrada", () => {
    const a = calcularDistribuciones(1000, [
      { id: 2, porcentaje: 40 },
      { id: 1, porcentaje: 60 },
    ]);
    const b = calcularDistribuciones(1000, [
      { id: 1, porcentaje: 60 },
      { id: 2, porcentaje: 40 },
    ]);
    expect(a).toEqual(b);
  });

  it("un solo destino al 100%: recibe el importe completo sin redondeo", () => {
    const result = calcularDistribuciones(750, [{ id: 1, porcentaje: 100 }]);
    expect(result).toEqual([{ destinoId: 1, importeCalculado: 750 }]);
  });

  it("una sola compra: la suma de distribuciones es exactamente el importe base (invariante spec)", () => {
    const destinos = [{ id: 1, porcentaje: 70 }, { id: 2, porcentaje: 10 }, { id: 3, porcentaje: 10 }, { id: 4, porcentaje: 10 }];
    const dist = calcularDistribuciones(105704.01, destinos);
    const suma = dist.reduce((acc, d) => acc + d.importeCalculado, 0);
    expect(Math.round(suma * 100) / 100).toBe(105704.01);
  });
});
