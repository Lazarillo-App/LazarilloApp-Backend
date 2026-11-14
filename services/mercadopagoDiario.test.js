// Mercado Pago diario (14/11/2026): qué días trae cada vuelta.
const test = require('node:test');
const assert = require('node:assert');
const { rangoDiario } = require('./mercadopagoDiario');

test('trae los últimos 10 días si ya está al día', () => {
  assert.deepStrictEqual(rangoDiario('2026-11-13', '2026-11-14'), { desde: '2026-11-04', hasta: '2026-11-14' });
});
test('si quedó atrás, desde lo último guardado', () => {
  assert.deepStrictEqual(rangoDiario('2026-10-20', '2026-11-14'), { desde: '2026-10-20', hasta: '2026-11-14' });
});
test('nunca más de 92 días por vuelta', () => {
  assert.deepStrictEqual(rangoDiario('2025-01-01', '2026-11-14'), { desde: '2026-08-15', hasta: '2026-11-14' });
});
test('sin nada guardado, los últimos 10 días', () => {
  assert.deepStrictEqual(rangoDiario(null, '2026-11-14'), { desde: '2026-11-04', hasta: '2026-11-14' });
});
