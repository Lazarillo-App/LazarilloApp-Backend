// Portado de lazarillo_gestion/lib/apertura/vigencia.test.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { describe, it, expect } = require('../test-utils/vitest');
const { resolverVigencia, fechaEnVigencia } = require('./vigencia');

describe("resolverVigencia", () => {
  it("historico: no requiere fechas, siempre matchea", () => {
    const regla = { modo: "historico", fechaDesde: null, fechaHasta: null, extremosInclusivos: true };
    expect(resolverVigencia(regla)).toEqual({ tipo: "historico" });
  });

  it("entre_fechas: propaga desde/hasta/inclusivo", () => {
    const desde = new Date("2026-01-01");
    const hasta = new Date("2026-01-31");
    const regla = { modo: "entre_fechas", fechaDesde: desde, fechaHasta: hasta, extremosInclusivos: false };
    expect(resolverVigencia(regla)).toEqual({ tipo: "entre_fechas", desde, hasta, inclusivo: false });
  });

  it("entre_fechas sin fechaDesde: lanza error explícito (nunca silencioso)", () => {
    const regla = {
      modo: "entre_fechas",
      fechaDesde: null,
      fechaHasta: new Date("2026-01-31"),
      extremosInclusivos: true,
    };
    expect(() => resolverVigencia(regla)).toThrow(/fechaDesde/);
  });

  it("entre_fechas sin fechaHasta: lanza error explícito", () => {
    const regla = {
      modo: "entre_fechas",
      fechaDesde: new Date("2026-01-01"),
      fechaHasta: null,
      extremosInclusivos: true,
    };
    expect(() => resolverVigencia(regla)).toThrow(/fechaHasta/);
  });

  it("desde_adelante: requiere solo fechaDesde", () => {
    const desde = new Date("2026-06-01");
    const regla = { modo: "desde_adelante", fechaDesde: desde, fechaHasta: null, extremosInclusivos: true };
    expect(resolverVigencia(regla)).toEqual({ tipo: "desde_adelante", desde, inclusivo: true });
  });

  it("desde_adelante sin fechaDesde: lanza error", () => {
    const regla = { modo: "desde_adelante", fechaDesde: null, fechaHasta: null, extremosInclusivos: true };
    expect(() => resolverVigencia(regla)).toThrow(/fechaDesde/);
  });

  it("desde_atras: requiere solo fechaHasta", () => {
    const hasta = new Date("2026-03-01");
    const regla = { modo: "desde_atras", fechaDesde: null, fechaHasta: hasta, extremosInclusivos: false };
    expect(resolverVigencia(regla)).toEqual({ tipo: "desde_atras", hasta, inclusivo: false });
  });

  it("desde_atras sin fechaHasta: lanza error", () => {
    const regla = { modo: "desde_atras", fechaDesde: null, fechaHasta: null, extremosInclusivos: true };
    expect(() => resolverVigencia(regla)).toThrow(/fechaHasta/);
  });
});

describe("fechaEnVigencia", () => {
  const entreEneEne = {
    modo: "entre_fechas", extremosInclusivos: true,
    fechaDesde: new Date("2026-01-01"), fechaHasta: new Date("2026-01-31"),
  };
  it("historico: cualquier fecha", () => {
    expect(fechaEnVigencia(new Date("1999-05-05"), { modo: "historico", fechaDesde: null, fechaHasta: null, extremosInclusivos: true })).toBe(true);
  });
  it("entre_fechas inclusivo: dentro true, fuera false, borde true", () => {
    expect(fechaEnVigencia(new Date("2026-01-15"), entreEneEne)).toBe(true);
    expect(fechaEnVigencia(new Date("2026-02-01"), entreEneEne)).toBe(false);
    expect(fechaEnVigencia(new Date("2026-01-31"), entreEneEne)).toBe(true);
  });
  it("entre_fechas exclusivo: borde false", () => {
    expect(fechaEnVigencia(new Date("2026-01-31"), { ...entreEneEne, extremosInclusivos: false })).toBe(false);
  });
  it("desde_adelante: fechas >= desde", () => {
    const v = { modo: "desde_adelante", extremosInclusivos: true, fechaDesde: new Date("2026-06-01"), fechaHasta: null };
    expect(fechaEnVigencia(new Date("2026-06-01"), v)).toBe(true);
    expect(fechaEnVigencia(new Date("2026-05-31"), v)).toBe(false);
  });
  it("desde_atras: fechas <= hasta", () => {
    const v = { modo: "desde_atras", extremosInclusivos: true, fechaDesde: null, fechaHasta: new Date("2026-06-30") };
    expect(fechaEnVigencia(new Date("2026-06-30"), v)).toBe(true);
    expect(fechaEnVigencia(new Date("2026-07-01"), v)).toBe(false);
  });
});
