'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { _puros: m } = require('./mantenimiento');

test('siguienteFecha: días, semanas y meses', () => {
  assert.equal(m.siguienteFecha('2026-11-21', 3, 'dias'), '2026-11-24');
  assert.equal(m.siguienteFecha('2026-11-21', 2, 'semanas'), '2026-12-05');
  assert.equal(m.siguienteFecha('2026-11-21', 1, 'meses'), '2026-12-21');
  assert.equal(m.siguienteFecha('2026-01-31', 1, 'meses'), '2026-02-28'); // no salta a marzo
  assert.equal(m.siguienteFecha('2026-12-15', 3, 'meses'), '2027-03-15');
});

test('ajustarDia: corre al primer día permitido (lunes a viernes)', () => {
  const habiles = [1, 2, 3, 4, 5];
  assert.equal(m.ajustarDia('2026-11-21', habiles), '2026-11-23'); // sábado → lunes
  assert.equal(m.ajustarDia('2026-11-24', habiles), '2026-11-24'); // martes queda
  assert.equal(m.ajustarDia('2026-11-21', null), '2026-11-21');
  assert.equal(m.siguienteFecha('2026-11-20', 1, 'semanas', habiles), '2026-11-27'); // viernes → viernes
  assert.equal(m.siguienteFecha('2026-11-20', 1, 'dias', habiles), '2026-11-23');    // viernes + 1 = sábado → lunes
});

test('textoFrecuencia', () => {
  assert.equal(m.textoFrecuencia(1, 'meses'), 'Cada mes');
  assert.equal(m.textoFrecuencia(3, 'semanas'), 'Cada 3 semanas');
});
