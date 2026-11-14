// Mercado Libre (14/11/2026): estado firmado, orden → compra y búsqueda paginada como comprador.
const test = require('node:test');
const assert = require('node:assert');
const ml = require('./mercadolibreService');

test('el estado firmado vale solo para el mismo negocio y usuario', () => {
  const s = ml._firmarEstado(147, 9);
  assert.deepStrictEqual(ml._verificarEstado(s, 147, 9), { ok: true });
  assert.strictEqual(ml._verificarEstado(s, 204, 9).error, 'otro_negocio');
  assert.strictEqual(ml._verificarEstado(s, 147, 10).error, 'otro_usuario');
  assert.strictEqual(ml._verificarEstado('basura', 147, 9).error, 'estado_vencido');
});

test('una orden de Mercado Libre se convierte en compra', () => {
  const c = ml._ordenACompra({
    id: 2000012345, date_created: '2026-11-03T10:00:00.000-03:00', date_closed: '2026-11-03T10:01:00.000-03:00',
    total_amount: 15990, paid_amount: 17490.5, currency_id: 'ARS', status: 'paid',
    seller: { id: 77, nickname: 'GASTRO_INSUMOS' },
    order_items: [{ item: { id: 'MLA1', title: 'Film strech 38cm ' }, quantity: 2, unit_price: 7995 }],
  });
  assert.strictEqual(c.order_id, 2000012345);
  assert.strictEqual(c.total, 17490.5);
  assert.strictEqual(c.vendedor, 'GASTRO_INSUMOS');
  assert.deepStrictEqual(c.items, [{ titulo: 'Film strech 38cm', cantidad: 2, precio: 7995 }]);
  assert.strictEqual(ml._ordenACompra({}), null);
});

test('busca como comprador, en hora de Argentina, de a 50', async () => {
  const urls = [];
  const orden = (i) => ({ id: i, date_created: '2026-11-03T10:00:00.000-03:00', total_amount: 10, status: 'paid' });
  const compras = await ml._traerOrdenes('T', 55, '2026-11-01', '2026-11-13', {
    fetchPagina: async (url) => {
      urls.push(url);
      const off = Number(new URL(url).searchParams.get('offset'));
      const n = off === 0 ? 50 : 7;
      return { results: Array.from({ length: n }, (_, k) => orden(off + k + 1)), paging: { total: 57 } };
    },
  });
  assert.strictEqual(compras.length, 57);
  assert.strictEqual(urls.length, 2);
  const u = new URL(urls[0]);
  assert.strictEqual(u.searchParams.get('buyer'), '55');
  assert.strictEqual(u.searchParams.get('order.date_created.from'), '2026-11-01T00:00:00.000-03:00');
});
