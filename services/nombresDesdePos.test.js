// Nombres de clientes de MP desde el POS (tablero #57, 16/11/2026).
const test = require('node:test');
const assert = require('node:assert');
const { limpiarCupon, nombreValido } = require('./nombresDesdePos');

test('el cupón de Render queda como número de operación de MP', () => {
  assert.strictEqual(limpiarCupon(1403977466), '1403977466');
  assert.strictEqual(limpiarCupon('1403977466.0'), '1403977466');
  assert.strictEqual(limpiarCupon(' 1403977466 '), '1403977466');
  assert.strictEqual(limpiarCupon('1234'), '');
  assert.strictEqual(limpiarCupon('00000000'), '');
  assert.strictEqual(limpiarCupon(null), '');
});

test('CLINOMBRE genéricos no cuentan como nombre', () => {
  assert.strictEqual(nombreValido('  JUAN   PEREZ '), 'JUAN PEREZ');
  for (const g of ['CONSUMIDOR FINAL', 'Consumidor  Final', 'C.F.', 'VARIOS', 'mostrador', '---', '12345', 'ab', '']) {
    assert.strictEqual(nombreValido(g), '', g);
  }
});
