// Conexión con Mercado Pago (14/11/2026): estado firmado, pago → fila de banco y búsqueda paginada.
const test = require('node:test');
const assert = require('node:assert');
const mp = require('./mercadopagoService');

test('el estado firmado lleva la sucursal y solo vale para el mismo negocio y usuario', () => {
  const s = mp._firmarEstado(147, 9, 31);
  assert.deepStrictEqual(mp._verificarEstado(s, 147, 9), { sucursal: 31 });
  assert.deepStrictEqual(mp._verificarEstado(mp._firmarEstado(147, 9), 147, 9), { sucursal: 0 });
  assert.strictEqual(mp._verificarEstado(s, 204, 9).error, 'otro_negocio');
  assert.strictEqual(mp._verificarEstado(s, 147, 10).error, 'otro_usuario');
  assert.strictEqual(mp._verificarEstado('basura', 147, 9).error, 'estado_vencido');
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

test('el nombre del pagador sale de donde lo mande Mercado Pago', () => {
  const base = { id: 9, status: 'approved', transaction_amount: 300000, date_created: '2026-11-06T16:12:00.000-03:00' };
  assert.strictEqual(mp._pagoAFila({ ...base, payer: { first_name: null, last_name: null } }).cliente, '');
  assert.strictEqual(mp._pagoAFila({ ...base, payer: { first_name: '', last_name: '' },
    point_of_interaction: { transaction_data: { bank_info: { payer: { long_name: 'Angulo  Marquez Antony Rosnerr' } } } } }).cliente, 'Angulo Marquez Antony Rosnerr');
  assert.strictEqual(mp._pagoAFila({ ...base, card: { cardholder: { name: 'ANA PEREZ' } } }).cliente, 'ANA PEREZ');
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

test('columnas extra: comisión, cuotas y retenciones por separado, referencia y documento', () => {
  const p = {
    id: 9, status: 'approved', transaction_amount: 10000, date_approved: '2026-11-10T15:00:00.000-04:00',
    payment_type_id: 'credit_card', payment_method_id: 'visa', installments: 3, external_reference: 'MX-4512',
    money_release_date: '2026-11-24T10:00:00.000-04:00', pos_id: '77', store_id: '12',
    payer: { identification: { type: 'CUIT', number: '20 12345678 9' } }, card: { last_four_digits: '4242' },
    fee_details: [{ type: 'mercadopago_fee', amount: 300, fee_payer: 'collector' }, { type: 'financing_fee', amount: 800, fee_payer: 'collector' },
      { type: 'financing_fee', amount: 500, fee_payer: 'payer' }],
    transaction_details: { net_received_amount: 8650 },
  };
  const f = mp._pagoAFila(p);
  assert.strictEqual(f.comisionMp, 300);
  assert.strictEqual(f.costoCuotas, 800);
  assert.strictEqual(f.retenciones, 250); // 10000 − 8650 − 300 − 800
  assert.strictEqual(f.ref, 'MX-4512');
  assert.strictEqual(f.doc, '20123456789');
  assert.strictEqual(f.docTipo, 'CUIT');
  assert.strictEqual(f.acredita, '2026-11-24');
  assert.strictEqual(f.cuotas, 3);
  assert.strictEqual(f.caja, '77');
  assert.strictEqual(f.tarjeta, '4242');
});

test('sin neto de MP no se inventan retenciones', () => {
  assert.strictEqual(mp._descuentosDe({ transaction_amount: 100 }).retenciones, null);
});

test('devoluciones: total, parcial, contracargo y disputa; un cobro normal no', () => {
  const base = { id: 1, transaction_amount: 5000, date_created: '2026-11-01T12:00:00.000-03:00', date_last_updated: '2026-11-05T09:30:00.000-03:00', payment_type_id: 'account_money' };
  const tot = mp._devolucionAFila({ ...base, status: 'refunded', transaction_amount_refunded: 5000 });
  assert.strictEqual(tot.tipo, 'Devolución'); assert.strictEqual(tot.imp, 5000); assert.strictEqual(tot.fecha, '2026-11-05');
  assert.strictEqual(tot.cobroFecha, '2026-11-01'); assert.strictEqual(tot.parcial, false);
  const par = mp._devolucionAFila({ ...base, status: 'approved', transaction_amount_refunded: 1200, refunds: [{ date_created: '2026-11-03T10:00:00.000-03:00' }] });
  assert.strictEqual(par.parcial, true); assert.strictEqual(par.imp, 1200); assert.strictEqual(par.fecha, '2026-11-03');
  assert.strictEqual(mp._devolucionAFila({ ...base, status: 'charged_back' }).tipo, 'Contracargo');
  assert.strictEqual(mp._devolucionAFila({ ...base, status: 'in_mediation' }).tipo, 'En disputa');
  assert.strictEqual(mp._devolucionAFila({ ...base, status: 'approved' }), null);
  assert.strictEqual(mp._devolucionAFila({ ...base, status: 'rejected' }), null);
});
