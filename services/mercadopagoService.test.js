// Conexión con Mercado Pago (14/11/2026): estado firmado, pago → fila de banco y búsqueda paginada.
const test = require('node:test');
const assert = require('node:assert');
const mp = require('./mercadopagoService');

test('el estado firmado solo vale para el mismo negocio y usuario', () => {
  const s = mp._firmarEstado(147, 9);
  assert.strictEqual(mp._verificarEstado(s, 147, 9), null);
  assert.strictEqual(mp._verificarEstado(s, 204, 9), 'otro_negocio');
  assert.strictEqual(mp._verificarEstado(s, 147, 10), 'otro_usuario');
  assert.strictEqual(mp._verificarEstado('basura', 147, 9), 'estado_vencido');
});

test('un pago aprobado se convierte en fila de banco en hora de Argentina', () => {
  const f = mp._pagoAFila({
    id: 123, status: 'approved', transaction_amount: 15600.4, date_created: '2026-10-01T23:30:00.000-04:00',
    date_approved: '2026-10-01T23:30:05.000-04:00', payment_method_id: 'account_money', payment_type_id: 'account_money',
    payer: { first_name: 'Ana', last_name: 'Perez' }, description: 'Propina mesa 4',
  });
  assert.strictEqual(f.id, 'mp123');
  assert.strictEqual(f.fecha, '2026-10-02'); // 23:30 en -04 = 00:30 del día siguiente en Argentina
  assert.strictEqual(f.hora, '00:30');
  assert.strictEqual(f.imp, 15600);
  assert.strictEqual(f.cliente, 'Ana Perez');
  assert.strictEqual(f.tipoMedio, 'Dinero en cuenta');
  assert.strictEqual(f.tipDesc, true);
  assert.strictEqual(mp._pagoAFila({ id: 1, status: 'refunded', transaction_amount: 10, date_created: '2026-10-01T10:00:00Z' }), null);
  assert.strictEqual(mp._pagoAFila({ id: 2, status: 'approved', transaction_amount: -10, date_created: '2026-10-01T10:00:00Z' }), null);
});

test('la búsqueda va día por día y pagina de a 100', async () => {
  const urls = [];
  const pago = (i, dia) => ({ id: i, status: 'approved', transaction_amount: 100, date_created: `${dia}T12:00:00.000-03:00` });
  const filas = await mp._traerCobros('T', 55, '2026-10-01', '2026-10-02', {
    fetchPagina: async (url) => {
      urls.push(url);
      const u = new URL(url);
      const dia = u.searchParams.get('begin_date').slice(0, 10);
      const off = Number(u.searchParams.get('offset'));
      if (dia === '2026-10-01') {
        const n = off === 0 ? 100 : 30;
        return { results: Array.from({ length: n }, (_, k) => pago(off + k, dia)), paging: { total: 130 } };
      }
      return { results: [pago(999, dia)], paging: { total: 1 } };
    },
  });
  assert.strictEqual(filas.length, 131);
  assert.strictEqual(urls.length, 3);
  assert.ok(urls[0].includes('collector.id=55'));
  assert.ok(urls[0].includes('status=approved'));
});
