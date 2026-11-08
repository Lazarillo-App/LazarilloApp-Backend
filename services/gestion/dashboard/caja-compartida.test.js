'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { resolverCaja } = require('./caja-compartida');

// Ramos: Bar (147) es el ancla, Canchas principal (204, NULL) comparte; San Justo (204/15) tiene su caja.
const RAMOS = [
  { grupo: 'ramos', business_id: '147', branch_id: null, ancla: true },
  { grupo: 'ramos', business_id: '204', branch_id: null, ancla: false },
];

test('Bar: suma Canchas principal y guarda en sí mismo', () => {
  assert.deepEqual(resolverCaja(RAMOS, 147, null), { extras: [{ businessId: 204, sucursal: null }], ancla: { businessId: 147, sucursal: null } });
  assert.deepEqual(resolverCaja(RAMOS, 147, undefined).extras, [{ businessId: 204, sucursal: null }]);
});

test('Canchas principal: suma el Bar y guarda en el Bar', () => {
  assert.deepEqual(resolverCaja(RAMOS, 204, null), { extras: [{ businessId: 147, sucursal: null }], ancla: { businessId: 147, sucursal: null } });
});

test('Canchas todas las sucursales: suma el Bar (San Justo ya está en el filtro), sin dónde guardar', () => {
  assert.deepEqual(resolverCaja(RAMOS, 204, undefined), { extras: [{ businessId: 147, sucursal: null }], ancla: null });
});

test('San Justo: su propia caja, nada cambia', () => {
  assert.deepEqual(resolverCaja(RAMOS, 204, 15), { extras: [], ancla: null });
});

test('negocio sin grupo: nada cambia', () => {
  assert.deepEqual(resolverCaja([], 210, null), { extras: [], ancla: null });
});
