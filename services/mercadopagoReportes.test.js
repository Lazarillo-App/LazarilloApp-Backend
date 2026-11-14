// Reporte de liberaciones de Mercado Pago (14/11/2026): pedirlo, leerlo y sacar nombres y egresos.
const test = require('node:test');
const assert = require('node:assert');
const r = require('./mercadopagoReportes');
const mp = require('./mercadopagoService');

const CSV = [
  'DATE,SOURCE_ID,RECORD_TYPE,DESCRIPTION,NET_CREDIT_AMOUNT,NET_DEBIT_AMOUNT,GROSS_AMOUNT,MP_FEE_AMOUNT,TAXES_AMOUNT,PAYER_NAME,PAYOUT_BANK_ACCOUNT_NUMBER',
  '2026-11-01T00:00:00.000-03:00,,initial_available_balance,,1000.00,0.00,,,,,',
  '2026-11-06T16:12:30.000-03:00,111,release,payment,300000.00,0.00,300000.00,0.00,0.00,"Angulo Marquez, Antony",',
  '2026-11-06T18:00:00.000-03:00,112,release,payment,9500.50,0.00,10000.00,-450.00,-49.50,,',
  '2026-11-07T10:00:00.000-03:00,113,release,payout,0.00,50000.00,,,,,0000003100012345678901',
  '2026-11-07T10:05:00.000-03:00,114,release,tax_payment_iibb,0.00,120.00,,,,,',
  '2026-11-30T23:59:59.000-03:00,,total,,309500.50,50120.00,,,,,',
].join('\n');

test('lee el CSV con comillas y saca nombres por id de pago', () => {
  const filas = r.parsearCSV(CSV);
  assert.strictEqual(filas.length, 6);
  const { nombres } = r.analizar(filas);
  assert.strictEqual(nombres.get('111'), 'Angulo Marquez, Antony');
  assert.strictEqual(nombres.has('112'), false);
});

test('los egresos: débitos de la cuenta y comisiones/retenciones sumadas por día', () => {
  const { egresos } = r.analizar(r.parsearCSV(CSV));
  const por = Object.fromEntries(egresos.map((e) => [e.id, e]));
  assert.strictEqual(por['mpr:113:payout'].tipo, 'Retiro');
  assert.strictEqual(por['mpr:113:payout'].imp, 50000);
  assert.strictEqual(por['mpr:113:payout'].cuenta, '0000003100012345678901');
  assert.strictEqual(por['mpr:114:tax_payment_iibb'].tipo, 'Impuesto');
  assert.strictEqual(por['mpc:2026-11-06:comision'].imp, 450);
  assert.strictEqual(por['mpc:2026-11-06:retencion'].imp, 49.5);
  assert.strictEqual(egresos.length, 4);
});

test('el CSV con punto y coma también se lee', () => {
  const f = r.parsearCSV('A;B\n1;"x;y"\n');
  assert.deepStrictEqual(f, [{ A: '1', B: 'x;y' }]);
});

test('el rango va en días de Argentina', () => {
  assert.strictEqual(r._inicioAR('2026-11-01'), '2026-11-01T03:00:00Z');
  assert.strictEqual(r._finAR('2026-11-13'), '2026-11-14T02:59:59Z');
});

test('si ya hay un reporte de ese rango no se pide otro; si no hay, se pide', async () => {
  const llamadas = [];
  const llamarCon = (lista) => async (url, o = {}) => {
    llamadas.push(`${o.method || 'GET'} ${url.replace('https://api.mercadopago.com', '')}`);
    if (url.endsWith('/list')) return { ok: true, status: 200, data: lista };
    return { ok: true, status: 202, data: {} };
  };
  const b = r._inicioAR('2026-11-01'); const e = r._finAR('2026-11-13');
  assert.deepStrictEqual(await r.buscarOPedir('T', '2026-11-01', '2026-11-13', { llamar: llamarCon([{ begin_date: b, end_date: e, status: 'processed', file_name: 'x.csv' }]) }), { listo: true, archivo: 'x.csv' });
  assert.deepStrictEqual(await r.buscarOPedir('T', '2026-11-01', '2026-11-13', { llamar: llamarCon([{ begin_date: b, end_date: e, status: 'pending' }]) }), { pendiente: true });
  llamadas.length = 0;
  assert.deepStrictEqual(await r.buscarOPedir('T', '2026-11-01', '2026-11-13', { llamar: llamarCon([]) }), { pendiente: true });
  assert.ok(llamadas.includes('POST /v1/account/release_report'));
});

test('la configuración suma las columnas que faltan sin sacar las que hay', async () => {
  let enviado = null;
  const ll = async (url, o = {}) => {
    if (!o.method) return { ok: true, status: 200, data: { columns: [{ key: 'DATE' }, { key: 'OTRA' }], scheduled: false, frequency: { type: 'monthly', value: 1, hour: 0 } } };
    enviado = o.body; return { ok: true, status: 200, data: {} };
  };
  assert.deepStrictEqual(await r.asegurarConfig('T', { llamar: ll }), { ok: true });
  const keys = enviado.columns.map((c) => c.key);
  assert.ok(keys.includes('OTRA') && keys.includes('PAYER_NAME'));
  assert.strictEqual(keys.filter((k) => k === 'DATE').length, 1);
  assert.strictEqual('scheduled' in enviado, false);
});

test('un pago que hizo la cuenta es un egreso; lo que se paga a sí misma no', () => {
  const base = { id: 7, status: 'approved', transaction_amount: 1234.5, date_created: '2026-11-05T12:00:00.000-03:00', payment_type_id: 'account_money' };
  const e = mp._pagoHechoAFila({ ...base, collector_id: 999, description: 'Proveedor verdura' }, 55);
  assert.strictEqual(e.id, 'mpp7');
  assert.strictEqual(e.imp, 1234.5);
  assert.strictEqual(e.detalle, 'Proveedor verdura');
  assert.strictEqual(e.origen, 'pago');
  assert.strictEqual(mp._pagoHechoAFila({ ...base, collector_id: 55 }, 55), null);
  assert.strictEqual(mp._pagoHechoAFila({ ...base, collector_id: 999, operation_type: 'money_transfer' }, 55).tipo, 'Transferencia');
});
