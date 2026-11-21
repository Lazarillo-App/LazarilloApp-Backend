'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { _puros: p } = require('./produccion');

test('fechaISO valida el formato y la fecha', () => {
  assert.equal(p.fechaISO('2026-11-21'), '2026-11-21');
  assert.equal(p.fechaISO('2026-02-30'), null);
  assert.equal(p.fechaISO('21/11/2026'), null);
  assert.equal(p.fechaISO(null), null);
});

test('lunesDe: la semana va de lunes a domingo', () => {
  assert.equal(p.lunesDe('2026-11-21'), '2026-11-16'); // sábado
  assert.equal(p.lunesDe('2026-11-22'), '2026-11-16'); // domingo
  assert.equal(p.lunesDe('2026-11-16'), '2026-11-16'); // lunes
  assert.equal(p.lunesDe('2026-11-01'), '2026-10-26'); // cruza de mes
});

test('tandas: 1, ½, 1,5; nada de cero ni negativos', () => {
  assert.equal(p.tandasValidas(1), 1);
  assert.equal(p.tandasValidas('0,5'), 0.5);
  assert.equal(p.tandasValidas('1.5'), 1.5);
  assert.equal(p.tandasValidas(0), null);
  assert.equal(p.tandasValidas(-1), null);
  assert.equal(p.tandasValidas('x'), null);
});

test('segundosHasta suma el tramo en curso y no las pausas', () => {
  const ahora = new Date('2026-11-21T12:10:00Z');
  assert.equal(p.segundosHasta({ segundos_trabajados: 300, corriendo_desde: null }, ahora), 300);
  assert.equal(p.segundosHasta({ segundos_trabajados: 300, corriendo_desde: '2026-11-21T12:00:00Z' }, ahora), 900);
});

test('escalarItems multiplica por las tandas', () => {
  const out = p.escalarItems([{ id: 1, insumo_id: 9, nombre: 'Papa', cantidad: 2, unidad: 'kg', orden: 0 }, { id: 2, nombre: 'Sal', cantidad: null, unidad: 'gr' }], 0.5);
  assert.equal(out[0].cantidad, 1);
  assert.equal(out[0].receta_item_id, 1);
  assert.equal(out[1].cantidad, null);
  assert.equal(out[1].orden, 1);
});

test('copiarTareas mantiene el día de la semana', () => {
  const out = p.copiarTareas([{ fecha: '2026-11-16', titulo: 'A' }, { fecha: '2026-11-22', titulo: 'B' }], '2026-11-16', '2026-11-23');
  assert.deepEqual(out.map((t) => t.fecha), ['2026-11-23', '2026-11-29']);
});

test('resumirPanel: real solo de hechas, estimado sin canceladas', () => {
  const t = (o) => ({ estado: 'hecha', segundos: 0, minutos_estimados: null, tandas: 1, rinde_esperado: null, rinde_real: null, cambios: null, ...o });
  const r = p.resumirPanel([
    t({ responsable_user_id: 1, responsable: 'Ana', insumo_id: 5, titulo: 'Puré', segundos: 1800, minutos_estimados: 40, rinde_esperado: 6, rinde_real: 5.5 }),
    t({ responsable_user_id: 1, responsable: 'Ana', insumo_id: 5, titulo: 'Puré', estado: 'pendiente', minutos_estimados: 40 }),
    t({ responsable_user_id: 2, responsable: 'Beto', insumo_id: 6, titulo: 'Arroz', estado: 'cancelada', minutos_estimados: 20, cambios: 'pendiente' }),
  ]);
  assert.equal(r.total.tareas, 3);
  assert.equal(r.total.hechas, 1);
  assert.equal(r.total.minutos_reales, 30);
  assert.equal(r.total.minutos_estimados, 80);
  assert.equal(r.total.estimado_de_hechas, 40);
  assert.equal(r.total.cambios, 1);
  const ana = r.personas.find((x) => x.user_id === 1);
  assert.equal(ana.hechas, 1);
  assert.equal(ana.pendientes, 1);
  const pure = r.elaborados.find((x) => x.insumo_id === 5);
  assert.equal(pure.rinde_real, 5.5);
});
