// Portado de lazarillo_gestion/lib/dashboard/equilibrio.test.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { describe, expect, it } = require('../test-utils/vitest');
const { equilibrioMes, equilibrioProyectado, pctVariableReciente } = require('./equilibrio');

describe("punto de equilibrio", () => {
  it("septiembre del Bar: lo que queda arriba del equilibrio es el resultado", () => {
    // ventas 88,4 · egresos 80,05 · variables 31,44 (35,6%)
    const e = equilibrioMes(88.4, 80.05, 31.44);
    expect(e.fijos).toBeCloseTo(48.61, 2);
    expect(e.equilibrio).toBeCloseTo(75.47, 1);
    expect(e.diferencia * e.queda).toBeCloseTo(88.4 - 80.05, 6);
  });
  it("mes con pérdida: equilibrio arriba de lo vendido", () => {
    const e = equilibrioMes(68.5, 75.39, 27.67);
    expect(e.diferencia).toBeLessThan(0);
    expect(e.diferencia * e.queda).toBeCloseTo(68.5 - 75.39, 6);
  });
  it("sin ventas no hay equilibrio; si lo variable se come todo, null", () => {
    expect(equilibrioMes(0, 10, 0)).toBeNull();
    expect(equilibrioMes(10, 20, 10).equilibrio).toBeNull();
  });
  it("% variable reciente ponderado por ventas", () => {
    expect(pctVariableReciente([{ ventas: 100, variable: 30 }, { ventas: 300, variable: 120 }])).toBeCloseTo(0.375);
    expect(pctVariableReciente([])).toBeNull();
  });
  it("mes en curso: cuánto falta y por día", () => {
    const p = equilibrioProyectado({ ventasProy: 90, egresosProy: 80, pctVariable: 0.35, facturado: 40, diasRestantes: 10 });
    // fijos = 80 − 31,5 = 48,5 → equilibrio 74,6 → faltan 34,6 en 10 días
    expect(p.equilibrio).toBeCloseTo(74.62, 1);
    expect(p.falta).toBeCloseTo(34.62, 1);
    expect(p.porDia).toBeCloseTo(3.46, 1);
    const ya = equilibrioProyectado({ ventasProy: 90, egresosProy: 80, pctVariable: 0.35, facturado: 80, diasRestantes: 3 });
    expect(ya.falta).toBe(0);
    expect(ya.porDia).toBeNull();
  });
});
