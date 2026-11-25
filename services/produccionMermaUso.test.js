// «Usar esta merma» (25/11/2026): cuentas puras.
const test = require('node:test');
const assert = require('node:assert');
const { _puros: { pctDe, factorDe } } = require('./produccionMermaUso');

test('pctDe: 1 kg → 800 g = 20 %', () => {
  assert.strictEqual(pctDe(1, 0.8), 20);
  assert.strictEqual(pctDe(5, 4.5), 10);
  assert.strictEqual(pctDe(0, 1), null);
});
test('factorDe: bruto / limpio (1 si no hay limpio)', () => {
  assert.strictEqual(factorDe(1, 0.8), 1.25);
  assert.strictEqual(factorDe(1, 0), 1);
});
