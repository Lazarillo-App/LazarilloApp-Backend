// Plan de cuentas en cero (Diego 14/11/2026): rubros siempre, conceptos al abrir.
'use strict';

const Module = require('module');
const origLoad = Module._load;
Module._load = function (req, parent, ...r) {
  if (req === '../db') { const sql = () => ({}); sql.raw = sql.join = sql; return { sql, db: {} }; }
  return origLoad.call(this, req, parent, ...r);
};
const { describe, it, expect } = require('../test-utils/vitest');
const { buildPivotData } = require('./pivot');
Module._load = origLoad;

const fila = (rubro, conc, mes, total) => ({
  rubro_codigo: rubro, rubro_nombre: `R${rubro}`, concepto_codigo: conc, concepto_nombre: `C${conc}`,
  proveedor_id: 1, proveedor_nombre: 'P', mes, total, row_id: `${conc}-${mes}`,
});
const est = (rubro, conc) => ({ rubro_codigo: rubro, rubro_nombre: `R${rubro}`, concepto_codigo: conc, concepto_nombre: conc ? `C${conc}` : null });

describe('buildPivotData con estructura', () => {
  it('negocio sin gastos: todos los rubros en cero con sus conceptos', () => {
    const d = buildPivotData([], {}, [est('1', '10'), est('1', '11'), est('2', '20'), est('3', null)]);
    expect(d.rows.map((r) => r.id)).toEqual(['1', '2', '3']);
    expect(d.rows[0].children.map((c) => c.conceptoCodigo)).toEqual(['10', '11']);
    expect(d.rows[2].children.length).toBe(0);
    expect(d.grandTotal).toBe(0);
    expect(d.rows.every((r) => r.vacio && r.rowTotal === 0)).toBe(true);
  });

  it('con gastos: no duplica rubro ni concepto y los totales no cambian', () => {
    const filas = [fila('1', '10', 3, 100), fila('1', '10', 4, 50)];
    const sin = buildPivotData(filas, {});
    const con = buildPivotData(filas, {}, [est('1', '10'), est('1', '11'), est('2', '20')]);
    expect(con.grandTotal).toBe(sin.grandTotal);
    expect(con.columnTotals).toEqual(sin.columnTotals);
    const r1 = con.rows.find((r) => r.id === '1');
    expect(r1.vacio).toBe(undefined);
    expect(r1.rowTotal).toBe(150);
    expect(r1.children.map((c) => [c.conceptoCodigo, !!c.vacio])).toEqual([['10', false], ['11', true]]);
    expect(con.rows.filter((r) => r.id === '1').length).toBe(1);
    expect(con.rows.find((r) => r.id === '2').vacio).toBe(true);
  });

  it('Sin Rubro sigue primero', () => {
    const d = buildPivotData([fila('__sin_rubro', '__sin_concepto', 1, 5)], {}, [est('1', '10')]);
    expect(d.rows[0].id).toBe('__sin_rubro');
  });
});
