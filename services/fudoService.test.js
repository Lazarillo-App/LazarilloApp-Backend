// Fudo (17/11/2026): lo puro del conector, con ventas armadas igual que las de la cuenta demo.
const test = require('node:test');
const assert = require('node:assert');
const { _diaLocal, _filtroCierre, _tramos, _ventasAFilas, _normalizar, _sugerir } = require('./fudoService');

const item = (id, prod, qty, price, canceled = null) => ({
  type: 'Item', id, attributes: { quantity: qty, price, canceled },
  relationships: { product: { data: { type: 'Product', id: prod } } },
});
const venta = (id, { closedAt = '2026-11-17T15:14:46Z', total, state = 'CLOSED', items = [], discounts = [] }) => ({
  type: 'Sale', id, attributes: { closedAt, total, saleState: state },
  relationships: {
    items: { data: items.map((i) => ({ type: 'Item', id: i })) },
    discounts: { data: discounts.map((d) => ({ type: 'Discount', id: d })) },
  },
});

test('el día es el de Argentina, no el de UTC', () => {
  assert.strictEqual(_diaLocal('2026-11-17T15:14:46Z'), '2026-11-17');
  assert.strictEqual(_diaLocal('2026-11-18T02:30:00Z'), '2026-11-17'); // 23:30 del 17 en Argentina
  assert.strictEqual(_diaLocal('2026-11-18T03:00:00Z'), '2026-11-18');
  assert.strictEqual(_diaLocal('basura'), null);
});

test('el filtro de cierre cubre días completos de Argentina', () => {
  assert.strictEqual(_filtroCierre('2026-11-17', '2026-11-17'), 'and(gte.2026-11-17T03:00:00Z,lt.2026-11-18T03:00:00Z)');
  assert.strictEqual(_filtroCierre('2026-11-01', '2026-11-07'), 'and(gte.2026-11-01T03:00:00Z,lt.2026-11-08T03:00:00Z)');
});

test('tramos parte el rango sin huecos ni solapes', () => {
  assert.deepStrictEqual(_tramos('2026-11-01', '2026-11-10', 7), [['2026-11-01', '2026-11-07'], ['2026-11-08', '2026-11-10']]);
  assert.deepStrictEqual(_tramos('2026-11-05', '2026-11-05', 7), [['2026-11-05', '2026-11-05']]);
  assert.strictEqual(_tramos('2026-08-19', '2026-11-16', 1).length, 90);
});

test('las ventas de la demo cuadran al peso: precio = total de línea, descuento repartido, cancelado afuera', () => {
  const r = _ventasAFilas([{
    data: [
      // Mesa 2: 1 Pollo crispy 15500 + 2 Wrap 37000 + 3 Agua 12000 = 64500, 10% → 58050
      venta('3', { total: 58050, items: ['7', '8', '9'], discounts: ['1'] }),
      // Para llevar: 2 Empanadas 5600 + 2 Cervezas 20000
      venta('2', { total: 25600, items: ['5', '6'] }),
      // Con una Picada cancelada: el total no la incluye
      venta('4', { total: 52800, items: ['20', '21', '22'] }),
      // Una venta abierta no cuenta
      venta('5', { total: 9999, state: 'IN-COURSE', items: ['30'] }),
    ],
    included: [
      item('7', '67', 1, 15500), item('8', '70', 2, 37000), item('9', '80', 3, 12000),
      item('5', '90', 2, 5600), item('6', '81', 2, 20000),
      item('20', '67', 2, 31000), item('21', '95', 1, 5500, true), item('22', '96', 1, 21800),
      item('30', '67', 1, 9999),
      { type: 'Discount', id: '1', attributes: { amount: 0, canceled: null, percentage: 10, maxAmount: null }, relationships: { item: { data: null } } },
    ],
  }]);
  assert.strictEqual(r.ventas, 3);
  assert.strictEqual(r.diferencia, 0);
  const total = r.filas.reduce((s, f) => s + f.amount, 0);
  assert.strictEqual(total, 58050 + 25600 + 52800);
  const pollo = r.filas.find((f) => f.fudo_id === '67');
  assert.deepStrictEqual(pollo, { day: '2026-11-17', fudo_id: '67', qty: 3, amount: 13950 + 31000 });
  assert.strictEqual(r.filas.find((f) => f.fudo_id === '70').amount, 33300); // 37000 − 10%
  assert.ok(!r.filas.some((f) => f.fudo_id === '95'), 'la picada cancelada no entra');
});

test('descuento por monto, con tope, y descuento de un solo ítem', () => {
  const r = _ventasAFilas([{
    data: [
      venta('1', { total: 900, items: ['1', '2'], discounts: ['a'] }),
      venta('2', { total: 1500, items: ['3', '4'], discounts: ['b', 'c'] }),
    ],
    included: [
      item('1', 'A', 1, 600), item('2', 'B', 1, 400),
      { type: 'Discount', id: 'a', attributes: { amount: 100 }, relationships: {} },
      item('3', 'C', 1, 1000), item('4', 'D', 1, 1000),
      { type: 'Discount', id: 'b', attributes: { percentage: 50, maxAmount: 500 }, relationships: { item: { data: { type: 'Item', id: '3' } } } },
      { type: 'Discount', id: 'c', attributes: { amount: 300, canceled: true }, relationships: {} },
    ],
  }]);
  const de = (id) => r.filas.find((f) => f.fudo_id === id).amount;
  assert.strictEqual(de('A'), 540);
  assert.strictEqual(de('B'), 360);
  assert.strictEqual(de('C'), 500);
  assert.strictEqual(de('D'), 1000);
  assert.strictEqual(r.diferencia, 0);
});

test('sugerencia: por código si existe, si no por nombre; ambiguo no sugiere', () => {
  assert.strictEqual(_normalizar('  Café   con Leché! '), 'cafe con leche');
  const s = _sugerir(
    [
      { fudo_id: '1', nombre: 'Pollo crispy', codigo: null },
      { fudo_id: '2', nombre: 'lo que sea', codigo: '505' },
      { fudo_id: '3', nombre: 'Agua', codigo: null },
      { fudo_id: '4', nombre: 'Nada parecido', codigo: '999' },
    ],
    [
      { articulo_id: 10, nombre: 'POLLO CRISPY' },
      { articulo_id: 505, nombre: 'Otro' },
      { articulo_id: 20, nombre: 'Agua' },
      { articulo_id: 21, nombre: 'agua' },
    ]
  );
  assert.strictEqual(s.get('1'), 10);
  assert.strictEqual(s.get('2'), 505);
  assert.strictEqual(s.has('3'), false);
  assert.strictEqual(s.has('4'), false);
});

test('día de una columna DATE: Date local del driver, texto ISO o nada', () => {
  const { _diaDe } = require('./fudoService');
  assert.strictEqual(_diaDe(new Date(2026, 10, 16)), '2026-11-16'); // así la entrega node-pg
  assert.strictEqual(_diaDe('2026-11-16'), '2026-11-16');
  assert.strictEqual(_diaDe('2026-11-16T00:00:00.000Z'), '2026-11-16');
  assert.strictEqual(_diaDe(null), null);
  assert.strictEqual(_diaDe(new Date('basura')), null);
});
