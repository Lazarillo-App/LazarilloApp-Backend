// ARCA automático (18/11/2026): cuándo le toca a la PC y qué rango trae.
const test = require('node:test');
const assert = require('node:assert');
const { _tareaDe: tarea, _validarRango: rango } = require('./arcaConexion');

// 18/11/2026 15:00 en Argentina (18:00 UTC)
const AHORA = new Date('2026-11-18T18:00:00Z');

test('primera vez: los últimos 90 días hasta ayer', () => {
  assert.deepStrictEqual(tarea({ frecuencia: 'semanal' }, AHORA), { desde: '2026-08-19', hasta: '2026-11-17', motivo: 'semanal' });
});

test('después: desde lo ya traído menos una semana de repaso', () => {
  const c = { frecuencia: 'diaria', recibidos_hasta: '2026-11-16', ultima_corrida_at: '2026-11-17T12:00:00Z' };
  assert.deepStrictEqual(tarea(c, AHORA), { desde: '2026-11-09', hasta: '2026-11-17', motivo: 'diaria' });
});

test('frecuencia: diaria una vez por día, semanal cada 7, mensual al cambiar de mes, apagada nunca', () => {
  const hoy = '2026-11-18T13:00:00Z';
  assert.strictEqual(tarea({ frecuencia: 'diaria', ultima_corrida_at: hoy, recibidos_hasta: '2026-11-17' }, AHORA), null);
  assert.strictEqual(tarea({ frecuencia: 'semanal', ultima_corrida_at: '2026-11-13T12:00:00Z', recibidos_hasta: '2026-11-12' }, AHORA), null);
  assert.ok(tarea({ frecuencia: 'semanal', ultima_corrida_at: '2026-11-11T12:00:00Z', recibidos_hasta: '2026-11-10' }, AHORA));
  assert.strictEqual(tarea({ frecuencia: 'mensual', ultima_corrida_at: '2026-11-02T12:00:00Z', recibidos_hasta: '2026-11-01' }, AHORA), null);
  assert.ok(tarea({ frecuencia: 'mensual', ultima_corrida_at: '2026-10-30T12:00:00Z', recibidos_hasta: '2026-10-29' }, AHORA));
  assert.strictEqual(tarea({ frecuencia: 'apagada' }, AHORA), null);
});

test('«Traer ahora» manda aunque esté apagada', () => {
  const c = { frecuencia: 'apagada', pedido_at: '2026-11-18T17:00:00Z', pedido_desde: '2026-01-01', pedido_hasta: '2026-03-31' };
  assert.deepStrictEqual(tarea(c, AHORA), { desde: '2026-01-01', hasta: '2026-03-31', motivo: 'pedido' });
});

test('rango a mano: hasta ayer como mucho, no invertido, hasta 365 días', () => {
  assert.deepStrictEqual(rango('2026-10-01', '2026-12-31', AHORA), { desde: '2026-10-01', hasta: '2026-11-17' });
  assert.deepStrictEqual(rango('2026-11-10', '2026-11-01', AHORA), { error: 'rango_invertido' });
  assert.deepStrictEqual(rango('2024-01-01', '2026-11-01', AHORA), { error: 'rango_largo' });
  assert.deepStrictEqual(rango('ayer', '2026-11-01', AHORA), { error: 'fechas_invalidas' });
});
