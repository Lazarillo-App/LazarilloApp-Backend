// Conciliación desde MaxiRest (13/11/2026): qué pdv le toca a cada sucursal y el rango de fechas.
process.env.PDV_MAP_SIN_REFRESCO = '1';
const test = require('node:test');
const assert = require('node:assert');
const { PDV_MAP } = require('./maxiPdvMap');
const m = require('./conciliacionMaxiService');

test('cada sucursal toma su punto de venta: 0 es la principal', () => {
  assert.strictEqual(m.pdvDeSucursal(204, 0).pdv, 'FCRAMOS');
  assert.strictEqual(m.pdvDeSucursal(204, 15).pdv, 'FCSANJUSTO');
  assert.strictEqual(m.pdvDeSucursal(147, 0).pdv, 'BAR');
  assert.strictEqual(m.pdvDeSucursal(147, 99), null);
  assert.strictEqual(m.pdvDeSucursal(123456, 0), null);
  assert.ok(PDV_MAP.BAR);
});

test('el rango tiene que ser válido y de hasta 3 meses', () => {
  assert.deepStrictEqual(m.validarRango('2026-11-01', '2026-11-30'), { desde: '2026-11-01', hasta: '2026-11-30' });
  assert.strictEqual(m.validarRango('2026-11-30', '2026-11-01').error, 'fechas_invalidas');
  assert.strictEqual(m.validarRango('01/11/2026', '2026-11-30').error, 'fechas_invalidas');
  assert.strictEqual(m.validarRango('2026-01-01', '2026-11-30').error, 'periodo_muy_largo');
});
