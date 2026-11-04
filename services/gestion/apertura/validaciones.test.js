// Portado de lazarillo_gestion/lib/apertura/validaciones.test.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { describe, it, expect } = require('../test-utils/vitest');
const { validarSumaPorcentajes, encontrarSuperposicion, encontrarDestinoDuplicado, origenesSuperpuestos, origenAlcanza } = require('./validaciones');

describe("validarSumaPorcentajes", () => {
  it("acepta 100 exacto", () => {
    expect(validarSumaPorcentajes([{ porcentaje: 60 }, { porcentaje: 40 }])).toBe(true);
  });

  it("acepta reparto de 3 con redondeo binario menor a 0.01 (33.33/33.33/33.34)", () => {
    expect(
      validarSumaPorcentajes([{ porcentaje: 33.33 }, { porcentaje: 33.33 }, { porcentaje: 33.34 }])
    ).toBe(true);
  });

  it("rechaza suma != 100 (CA-10 de la spec)", () => {
    expect(validarSumaPorcentajes([{ porcentaje: 60 }, { porcentaje: 30 }])).toBe(false);
  });

  it("rechaza lista vacía", () => {
    expect(validarSumaPorcentajes([])).toBe(false);
  });
});

describe("encontrarSuperposicion", () => {
  it("detecta superposición entre dos rangos que se cruzan (CA-08: bloqueo de superposición)", () => {
    const nueva = {
      modo: "entre_fechas",
      extremosInclusivos: true,
      fechaDesde: new Date("2026-01-10"),
      fechaHasta: new Date("2026-02-10"),
    };
    const existentes = [
      { id: 5, modo: "entre_fechas", extremosInclusivos: true, fechaDesde: new Date("2026-02-01"), fechaHasta: new Date("2026-03-01") },
    ];
    expect(encontrarSuperposicion(nueva, existentes)).toBe(5);
  });

  it("no detecta superposición entre rangos consecutivos con extremos exclusivos (CA-09: coexistencia de reglas por período)", () => {
    const nueva = {
      modo: "entre_fechas",
      extremosInclusivos: false,
      fechaDesde: new Date("2026-02-01"),
      fechaHasta: new Date("2026-03-01"),
    };
    const existentes = [
      { id: 5, modo: "entre_fechas", extremosInclusivos: false, fechaDesde: new Date("2026-01-01"), fechaHasta: new Date("2026-02-01") },
    ];
    expect(encontrarSuperposicion(nueva, existentes)).toBeNull();
  });

  it("detecta superposición en el límite cuando ambos extremos son inclusivos", () => {
    const nueva = {
      modo: "entre_fechas",
      extremosInclusivos: true,
      fechaDesde: new Date("2026-02-01"),
      fechaHasta: new Date("2026-03-01"),
    };
    const existentes = [
      { id: 5, modo: "entre_fechas", extremosInclusivos: true, fechaDesde: new Date("2026-01-01"), fechaHasta: new Date("2026-02-01") },
    ];
    expect(encontrarSuperposicion(nueva, existentes)).toBe(5);
  });

  it("historico se superpone con cualquier otra regla activa del mismo concepto", () => {
    const nueva = { modo: "historico", fechaDesde: null, fechaHasta: null, extremosInclusivos: true };
    const existentes = [
      { id: 7, modo: "desde_adelante", fechaDesde: new Date("2030-01-01"), fechaHasta: null, extremosInclusivos: true },
    ];
    expect(encontrarSuperposicion(nueva, existentes)).toBe(7);
  });

  it("desde_adelante y desde_atras que no se cruzan: sin superposición", () => {
    const nueva = { modo: "desde_adelante", fechaDesde: new Date("2026-06-01"), fechaHasta: null, extremosInclusivos: true };
    const existentes = [
      { id: 3, modo: "desde_atras", fechaDesde: null, fechaHasta: new Date("2026-05-01"), extremosInclusivos: true },
    ];
    expect(encontrarSuperposicion(nueva, existentes)).toBeNull();
  });

  it("sin reglas existentes: no hay superposición", () => {
    const nueva = { modo: "historico", fechaDesde: null, fechaHasta: null, extremosInclusivos: true };
    expect(encontrarSuperposicion(nueva, [])).toBeNull();
  });

  it("devuelve el id de la PRIMERA regla en conflicto cuando hay varias", () => {
    const nueva = { modo: "historico", fechaDesde: null, fechaHasta: null, extremosInclusivos: true };
    const existentes = [
      { id: 1, modo: "entre_fechas", extremosInclusivos: true, fechaDesde: new Date("2026-01-01"), fechaHasta: new Date("2026-01-31") },
      { id: 2, modo: "entre_fechas", extremosInclusivos: true, fechaDesde: new Date("2026-02-01"), fechaHasta: new Date("2026-02-28") },
    ];
    expect(encontrarSuperposicion(nueva, existentes)).toBe(1);
  });
});

describe("encontrarDestinoDuplicado", () => {
  it("detecta el mismo local + mismo punto de venta repetido, devuelve el índice de la segunda aparición", () => {
    const destinos = [
      { localId: 1, puntoDeVentaId: 10 },
      { localId: 2, puntoDeVentaId: null },
      { localId: 1, puntoDeVentaId: 10 },
    ];
    expect(encontrarDestinoDuplicado(destinos)).toBe(2);
  });

  it("detecta 'todo el local' (puntoDeVentaId null) repetido para el mismo local", () => {
    const destinos = [
      { localId: 1, puntoDeVentaId: null },
      { localId: 1, puntoDeVentaId: null },
    ];
    expect(encontrarDestinoDuplicado(destinos)).toBe(1);
  });

  it("no marca duplicado entre distintos locales aunque compartan puntoDeVentaId", () => {
    const destinos = [
      { localId: 1, puntoDeVentaId: 10 },
      { localId: 2, puntoDeVentaId: 10 },
    ];
    expect(encontrarDestinoDuplicado(destinos)).toBeNull();
  });

  it("no marca duplicado entre distintos puntos de venta del mismo local", () => {
    const destinos = [
      { localId: 1, puntoDeVentaId: 10 },
      { localId: 1, puntoDeVentaId: 20 },
    ];
    expect(encontrarDestinoDuplicado(destinos)).toBeNull();
  });

  it("bloquea 'todo el local' contra un punto de venta específico ya usado del mismo local (se superponen, es la misma plata)", () => {
    const destinos = [
      { localId: 1, puntoDeVentaId: 20 },
      { localId: 1, puntoDeVentaId: null },
    ];
    expect(encontrarDestinoDuplicado(destinos)).toBe(1);
  });

  it("bloquea aunque solo UN punto de venta del local esté cubierto — no hace falta que estén todos", () => {
    const destinos = [
      { localId: 1, puntoDeVentaId: 20 },
      { localId: 1, puntoDeVentaId: 30 },
      { localId: 1, puntoDeVentaId: null },
    ];
    expect(encontrarDestinoDuplicado(destinos)).toBe(2);
  });

  it("ignora filas todavía vacías (localId null) al comparar", () => {
    const destinos = [
      { localId: null, puntoDeVentaId: null },
      { localId: null, puntoDeVentaId: null },
    ];
    expect(encontrarDestinoDuplicado(destinos)).toBeNull();
  });

  it("sin destinos: no hay duplicado", () => {
    expect(encontrarDestinoDuplicado([])).toBeNull();
  });
});

describe("origenesSuperpuestos", () => {
  it("mismo PDV puntual del mismo local: compiten", () => {
    expect(origenesSuperpuestos({ localId: 1, puntoDeVentaId: 10 }, { localId: 1, puntoDeVentaId: 10 })).toBe(true);
  });
  it("PDV puntual vs 'todo el local' del mismo local: compiten", () => {
    expect(origenesSuperpuestos({ localId: 1, puntoDeVentaId: 10 }, { localId: 1, puntoDeVentaId: null })).toBe(true);
  });
  it("PDV distintos del mismo local: no compiten", () => {
    expect(origenesSuperpuestos({ localId: 1, puntoDeVentaId: 10 }, { localId: 1, puntoDeVentaId: 20 })).toBe(false);
  });
  it("locales distintos: no compiten", () => {
    expect(origenesSuperpuestos({ localId: 1, puntoDeVentaId: null }, { localId: 2, puntoDeVentaId: null })).toBe(false);
  });
});

describe("origenAlcanza", () => {
  it("origen = PDV puntual: alcanza solo a las compras de ese PDV", () => {
    expect(origenAlcanza({ localId: 1, puntoDeVentaId: 10 }, { localId: 1, puntoDeVentaId: 10 })).toBe(true);
    expect(origenAlcanza({ localId: 1, puntoDeVentaId: 10 }, { localId: 1, puntoDeVentaId: 20 })).toBe(false);
  });
  it("origen = todo el local: alcanza a cualquier compra de ese local", () => {
    expect(origenAlcanza({ localId: 1, puntoDeVentaId: null }, { localId: 1, puntoDeVentaId: 20 })).toBe(true);
    expect(origenAlcanza({ localId: 1, puntoDeVentaId: null }, { localId: 2, puntoDeVentaId: 99 })).toBe(false);
  });
  it("compra sin local asignado: no la alcanza ningún origen", () => {
    expect(origenAlcanza({ localId: 1, puntoDeVentaId: null }, { localId: null, puntoDeVentaId: null })).toBe(false);
  });
});
