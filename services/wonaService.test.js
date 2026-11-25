// services/wonaService.test.js — lo puro del conector de Wona (sin base ni red).
const test = require('node:test');
const assert = require('node:assert');
const w = require('./wonaService');

test('filasPanel: una fila por día y origen, sin los ceros, con rowId estable', () => {
  const filas = w._filasPanel([
    { period: '2026-10-06', byOrigin: [{ origin: 'BUFFET', total: 925500, count: 114 }, { origin: 'BOOKING', total: 727000, count: 7 }, { origin: 'BOOKING_DEPOSIT', total: 0, count: 0 }] },
    { period: 'basura', byOrigin: [{ origin: 'BUFFET', total: 1 }] },
  ], 'eac47b2c-6dba-4bad');
  assert.strictEqual(filas.length, 2);
  assert.strictEqual(filas[0].rowId, 'wona-eac47b2c-2026-10-06-BUFFET');
  assert.strictEqual(filas[0].tipo, 'Buffet');
  assert.strictEqual(filas[1].tipo, 'Turnos');
  assert.strictEqual(filas[1].importe, 727000);
  assert.strictEqual(filas[0].fecha, '2026-10-06 12:00:00');
});

test('turnosPorDia: cuenta solo los turnos válidos, por día y tipo de cancha', () => {
  const tipos = new Map([['c1', 'Fútbol 5'], ['c2', 'Padel']]);
  const m = w._turnosPorDia([
    { reservationDate: '2026-10-01 17:00:00', status: 'CONFIRMED', price: 30000, installationUuid: 'c1' },
    { reservationDate: '2026-10-01 18:00:00', status: 'ACTIVE', price: 32000, installationUuid: 'c1' },
    { reservationDate: '2026-10-01 19:00:00', status: 'CANCELLED', price: 30000, installationUuid: 'c1' },
    { reservationDate: '2026-10-01 20:00:00', status: 'FIXED_REMOVED', price: 30000, installationUuid: 'c1' },
    { reservationDate: '2026-10-02 08:00:00', status: 'CONFIRMED', price: 20000, installationUuid: 'c2' },
    { reservationDate: '2026-10-02 09:00:00', status: 'CANCELLED_BY_PLAYER', price: 20000, installationUuid: 'c2' },
  ], tipos);
  assert.deepStrictEqual(m.get('2026-10-01|cancha:Fútbol 5'), { qty: 2, amount: 62000 });
  assert.deepStrictEqual(m.get('2026-10-02|cancha:Padel'), { qty: 1, amount: 20000 });
  assert.strictEqual(m.size, 2);
});

test('compraDeCarga: fecha local, un renglón por el total, sin borradas ni ceros', () => {
  const c = w._compraDeCarga({ id: 9182, providerName: 'EMPRESA 592', invoiceNumber: 401873360, total: '564624.00', createdAt: '2026-11-12T02:43:39.000Z', deletedAt: null });
  assert.strictEqual(c.fecha, '2026-11-11'); // 02:43 UTC = 23:43 del día anterior en Argentina
  assert.strictEqual(c.total, 564624);
  assert.strictEqual(c.externoId, '9182');
  assert.strictEqual(c.renglones[0].neto, 564624);
  assert.strictEqual(w._compraDeCarga({ id: 1, total: '10', createdAt: '2026-11-12T12:00:00Z', deletedAt: '2026-11-13T00:00:00Z' }), null);
  assert.strictEqual(w._compraDeCarga({ id: 2, total: '0', createdAt: '2026-11-12T12:00:00Z' }), null);
});

test('tramos de 31 días cubren el rango sin huecos', () => {
  const t = w._tramos('2026-01-01', '2026-03-05', 31);
  assert.deepStrictEqual(t[0], ['2026-01-01', '2026-01-31']);
  assert.strictEqual(t[t.length - 1][1], '2026-03-05');
});

test('normalizarTraer: las ventas no se apagan', () => {
  assert.deepStrictEqual(w._normalizarTraer({ ventas: false, compras: false }), { ventas: true, articulos: true, insumos: true, compras: false });
});
