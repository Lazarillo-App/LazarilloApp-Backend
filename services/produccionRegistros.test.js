'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { _puros: r } = require('./produccionRegistros');
const { _puros: p } = require('./produccion');

test('aBase: kilos a gramos, litros a ml, unidades igual', () => {
  assert.deepEqual(r.aBase(1.5, 'kg'), { cant: 1500, base: 'gr' });
  assert.deepEqual(r.aBase(0.2, 'lt'), { cant: 200, base: 'ml' });
  assert.deepEqual(r.aBase(3, 'u'), { cant: 3, base: 'u' });
});

test('sumarConsumos junta por insumo y separa por origen', () => {
  const out = r.sumarConsumos([
    { insumo_id: 1, nombre: 'Papa', cantidad: 7, unidad: 'kg', origen: 'produccion' },
    { insumo_id: 1, nombre: 'Papa', cantidad: 500, unidad: 'gr', origen: 'desperdicio' },
    { insumo_id: 1, nombre: 'Papa', cantidad: 1, unidad: 'kg', origen: 'merma' },
    { insumo_id: 2, nombre: 'Sal', cantidad: 200, unidad: 'gr', origen: 'mise' },
  ]);
  const papa = out.find((x) => x.insumo_id === 1);
  assert.equal(papa.produccion, 7000);
  assert.equal(papa.desperdicio, 500);
  assert.equal(papa.merma, 1000);
  assert.equal(papa.total, 8500);
  assert.equal(out[0].insumo_id, 1); // el de más consumo primero
  assert.equal(out.find((x) => x.insumo_id === 2).mise, 200);
});

test('loteDe: L + AAMMDD + número de tarea', () => {
  assert.equal(p.loteDe({ id: 345, fecha: '2026-11-21' }), 'L261121-345');
});
