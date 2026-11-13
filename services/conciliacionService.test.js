// Módulo de conciliación (14/11/2026): validación de lo que se guarda.
const test = require('node:test');
const assert = require('node:assert');
const { validarFuente, validarPeriodo } = require('./conciliacionService');

test('fuentes: tipo, filas y rango de fechas', () => {
  assert.strictEqual(validarFuente('otra', { filas: [] }).error, 'tipo_invalido');
  assert.strictEqual(validarFuente('banco', {}).error, 'faltan_filas');
  assert.strictEqual(validarFuente('banco', { filas: [1, 2] }).error, 'fila_invalida');
  const { fila } = validarFuente('ventas', { archivo: 'v.xlsx', filas: [{ fecha: '2026-10-05' }, { fecha: '2026-10-01' }, { fecha: 'x' }] });
  assert.strictEqual(fila.cantidad, 3);
  assert.strictEqual(fila.desde, '2026-10-01');
  assert.strictEqual(fila.hasta, '2026-10-05');
});

test('período: "desde|hasta" con fechas ISO', () => {
  assert.strictEqual(validarPeriodo('2026-10-01|2026-10-31'), '2026-10-01|2026-10-31');
  assert.strictEqual(validarPeriodo('2026-10-01|'), '2026-10-01|');
  assert.strictEqual(validarPeriodo('octubre'), null);
  assert.strictEqual(validarPeriodo(null), null);
});
