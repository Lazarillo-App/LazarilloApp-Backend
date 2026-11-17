const test = require('node:test');
const assert = require('node:assert');
const { todasOcultas } = require('./requireFuncion');

test('corta solo si todas las funciones pedidas (o su área) están ocultas', () => {
  assert.strictEqual(todasOcultas([], ['rrhh']), false);
  assert.strictEqual(todasOcultas(['administracion'], ['conciliacion', 'clientes']), true);
  assert.strictEqual(todasOcultas(['clientes'], ['conciliacion', 'clientes']), false);
  assert.strictEqual(todasOcultas(['clientes'], ['clientes']), true);
  assert.strictEqual(todasOcultas(['operacion'], ['rrhh']), true);
  assert.strictEqual(todasOcultas(['tableros'], ['rrhh']), false);
});
