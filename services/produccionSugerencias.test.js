'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { _puros: s } = require('./produccionSugerencias');

test('aUnidadDeRinde: misma familia, porciones con peso y sin conversión', () => {
  assert.equal(s.aUnidadDeRinde(150, 'gr', { rendimiento_unidad: 'kg' }), 0.15);
  assert.equal(s.aUnidadDeRinde(1, 'porcion', { rendimiento_unidad: 'porcion' }), 1);
  assert.equal(s.aUnidadDeRinde(150, 'gr', { rendimiento_unidad: 'porcion', rendimiento_peso: 300, unidad_peso: 'gr' }), 0.5);
  assert.equal(s.aUnidadDeRinde(150, 'gr', { rendimiento_unidad: 'porcion' }), null);
  assert.equal(s.aUnidadDeRinde(2, 'u', { rendimiento_unidad: 'kg' }), null);
});

test('aMedias: para arriba de a media tanda', () => {
  assert.equal(s.aMedias(2.1), 2.5);
  assert.equal(s.aMedias(2.5), 2.5);
  assert.equal(s.aMedias(0.2), 0.5);
  assert.equal(s.aMedias(0), 0);
});
