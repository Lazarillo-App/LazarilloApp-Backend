// El nombre de la forma de cobro no puede ser un número de factura (usuaria 25/11/2026, Comercio).
const test = require('node:test');
const assert = require('node:assert');
const { buildPivotData, _elegirNombre } = require('./pivot-ventas');

test('elegirNombre: el texto que más mueve, salteando los que parecen comprobantes', () => {
  assert.strictEqual(_elegirNombre(new Map([['FCB 0006-00029976', 999], ['MERCADOPAGO', 500], ['MERCADO PAGO', 10]])), 'MERCADOPAGO');
  assert.strictEqual(_elegirNombre(new Map([['EFECTIVO', 1]])), 'EFECTIVO');
  assert.strictEqual(_elegirNombre(new Map([['FCB 0006-00029976', 3]])), 'FCB 0006-00029976'); // sin otro, queda
});

test('buildPivotData: la fila de un código toma el nombre bueno aunque el comprobante venga primero', () => {
  const r = buildPivotData([
    { tipo_codigo: 'SALON', tipo_nombre: 'SALON', cobro_codigo: '12', cobro_nombre: 'FCB 0006-00029976', mes: 1, total: 100 },
    { tipo_codigo: 'SALON', tipo_nombre: 'SALON', cobro_codigo: '12', cobro_nombre: 'MERCADOPAGO', mes: 1, total: 5000 },
    { tipo_codigo: 'SALON', tipo_nombre: 'SALON', cobro_codigo: '1', cobro_nombre: 'EFECTIVO', mes: 1, total: 300 },
  ]);
  const salon = (r.data || r.rows || r).find ? (r.data || r.rows || r).find((x) => x.id === 'SALON') : null;
  const filas = (salon || r.tipos?.[0] || {}).children || [];
  assert.deepStrictEqual(filas.map((f) => f.nombre).sort(), ['EFECTIVO', 'MERCADOPAGO']);
  assert.strictEqual(filas.find((f) => f.nombre === 'MERCADOPAGO').rowTotal, 5100);
});
