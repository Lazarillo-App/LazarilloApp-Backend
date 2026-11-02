// Portado de lazarillo_gestion/lib/dashboard/flujo-caja-agg.test.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { describe, it, expect } = require('../test-utils/vitest');
const { aggregateFlujoCajaPorMes } = require('./flujo-caja-agg');

describe("aggregateFlujoCajaPorMes", () => {
  it("sin filas devuelve los 12 meses en null", () => {
    const result = aggregateFlujoCajaPorMes([]);
    expect(Object.keys(result)).toHaveLength(12);
    expect(result[1]).toBeNull();
    expect(result[12]).toBeNull();
  });

  it("PDV puntual: suma directo sin considerar el nivel local", () => {
    const rows = [
      { localId: 1, puntoDeVentaId: 10, mes: 3, monto: 100 },
      { localId: 1, puntoDeVentaId: 10, mes: 3, monto: 50 },
    ];
    const result = aggregateFlujoCajaPorMes(rows, 10);
    expect(result[3]).toBe(150);
  });

  it("sin PDV puntual: un local con carga solo a nivel PDV se suma", () => {
    const rows = [
      { localId: 1, puntoDeVentaId: 10, mes: 5, monto: 100 },
      { localId: 1, puntoDeVentaId: 11, mes: 5, monto: 200 },
    ];
    const result = aggregateFlujoCajaPorMes(rows);
    expect(result[5]).toBe(300);
  });

  it("sin PDV puntual: carga a ambos niveles para el mismo mes, gana el nivel local (no se duplica)", () => {
    const rows = [
      { localId: 1, puntoDeVentaId: null, mes: 5, monto: 500 },
      { localId: 1, puntoDeVentaId: 10, mes: 5, monto: 100 },
      { localId: 1, puntoDeVentaId: 11, mes: 5, monto: 200 },
    ];
    const result = aggregateFlujoCajaPorMes(rows);
    expect(result[5]).toBe(500);
  });

  it("múltiples locales se agregan independientemente y se suman entre sí", () => {
    const rows = [
      { localId: 1, puntoDeVentaId: null, mes: 6, monto: 500 },
      { localId: 2, puntoDeVentaId: 20, mes: 6, monto: 300 },
    ];
    const result = aggregateFlujoCajaPorMes(rows);
    expect(result[6]).toBe(800);
  });

  it("nivel local con monto 0 se ignora; si hay PDV con valor, se usa (monto 0 es sin dato)", () => {
    const rows = [
      { localId: 1, puntoDeVentaId: null, mes: 5, monto: 0 },
      { localId: 1, puntoDeVentaId: 10, mes: 5, monto: 200 },
    ];
    const result = aggregateFlujoCajaPorMes(rows);
    expect(result[5]).toBe(200);
  });

  it("una fila con monto 0 no cuenta como dato: el mes queda en null", () => {
    const meses = aggregateFlujoCajaPorMes(
      [{ localId: 2, puntoDeVentaId: null, mes: 6, monto: 0 }],
    );
    expect(meses[6]).toBeNull();
  });

  it("mismo mes con una fila en 0 y otra con valor real: agrega solo la real", () => {
    const meses = aggregateFlujoCajaPorMes(
      [
        { localId: 2, puntoDeVentaId: 10, mes: 9, monto: 0 },
        { localId: 2, puntoDeVentaId: 11, mes: 9, monto: 1000 },
      ],
    );
    expect(meses[9]).toBe(1000);
  });

  it("con puntoDeVentaId puntual, una fila en 0 tampoco cuenta", () => {
    const meses = aggregateFlujoCajaPorMes(
      [{ localId: 2, puntoDeVentaId: 10, mes: 9, monto: 0 }],
      10,
    );
    expect(meses[9]).toBeNull();
  });

  it("nivel local presente que neteo a 0 (ej. +500 y -500) le gana al PDV: devuelve 0, no cae al PDV", () => {
    const rows = [
      { localId: 1, puntoDeVentaId: null, mes: 5, monto: 500 },
      { localId: 1, puntoDeVentaId: null, mes: 5, monto: -500 },
      { localId: 1, puntoDeVentaId: 10, mes: 5, monto: 200 },
    ];
    const result = aggregateFlujoCajaPorMes(rows);
    expect(result[5]).toBe(0);
  });

  it("un monto negativo es un arqueo válido, no se filtra como 'sin dato'", () => {
    const meses = aggregateFlujoCajaPorMes(
      [{ localId: 2, puntoDeVentaId: null, mes: 4, monto: -300 }],
    );
    expect(meses[4]).toBe(-300);
  });
});
