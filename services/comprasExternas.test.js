// Compras de cualquier sistema → factura de Lazarillo (17/11/2026): lo puro.
const test = require('node:test');
const assert = require('node:assert');
const { _numeroDeComprobante, _registrosDeCompra } = require('./comprasExternas');

test('número de comprobante: el del sistema si tiene dígitos, si no el id externo', () => {
  assert.deepStrictEqual(_numeroDeComprobante({ comprobante: '0003-00001234', externoId: '9' }), { prefijo: '3', numero: '00001234' });
  assert.deepStrictEqual(_numeroDeComprobante({ comprobante: '0', externoId: '17' }), { prefijo: '0', numero: '17' });
  assert.deepStrictEqual(_numeroDeComprobante({ comprobante: null, externoId: '123456789012' }), { prefijo: '0', numero: '56789012' });
  const sinDigitos = _numeroDeComprobante({ externoId: 'abc' });
  assert.match(sinDigitos.numero, /^\d{1,8}$/);
});

test('renglones: con insumo va el concepto de su rubro; sin insumo el del proveedor; sin nada, sin concepto', () => {
  const insumos = new Map([[50, { codigo: '5', nombre: 'Lechuga', medida: 'kg', concepto: '210' }], [51, { codigo: null, nombre: 'Sal', medida: 'kg', concepto: null }]]);
  const lechuga = _registrosDeCompra(
    { total: 80000, renglones: [{ insumoId: 50, nombre: 'Lechuga', cantidad: 25, neto: 75000 }] },
    { insumos, conceptoSinInsumo: null, puntoDeVentaId: -7 });
  assert.deepStrictEqual(lechuga[0], { tipo: 'insumo', conceptoCodigo: '210', insumoCodigo: '5', nombre: 'Lechuga', medida: 'kg', cantidad: 25, neto: 75000, alicuota: 0, puntoDeVentaId: -7 });
  // los $5000 de más (impuestos) en un renglón aparte, sin concepto porque no hay del proveedor
  assert.deepStrictEqual(lechuga[1], { tipo: 'insumo', conceptoCodigo: null, insumoCodigo: null, nombre: 'Impuestos y otros', neto: 5000, alicuota: 0, puntoDeVentaId: -7 });

  const alquiler = _registrosDeCompra({ total: 250000, categoria: 'Alquiler', renglones: [] }, { insumos, conceptoSinInsumo: '300', puntoDeVentaId: -7 });
  assert.deepStrictEqual(alquiler, [{ tipo: 'concepto', conceptoCodigo: '300', nombre: 'Alquiler', neto: 250000, alicuota: 0, puntoDeVentaId: -7 }]);

  const sal = _registrosDeCompra({ total: 900, renglones: [{ insumoId: 51, neto: 900 }] }, { insumos, conceptoSinInsumo: null, puntoDeVentaId: 3 });
  assert.strictEqual(sal[0].conceptoCodigo, null);
  assert.strictEqual(sal[0].nombre, 'Sal');
  assert.strictEqual(sal.length, 1);

  const desconocido = _registrosDeCompra({ total: 100, renglones: [{ insumoId: 999, nombre: 'Algo', neto: 100 }] }, { insumos, conceptoSinInsumo: null, puntoDeVentaId: 3 });
  assert.strictEqual(desconocido[0].insumoCodigo, null);
});

test('conceptos básicos: rubros del Panel con «Gastos en personal» = 3 y conceptos desde 1000, sin repetir', () => {
  const { armarBase } = require('./gestion/conceptos/base');
  const { rubros, conceptos } = armarBase();
  assert.strictEqual(rubros.find((r) => r.nombre === 'Gastos en personal').codigo, '3');
  assert.strictEqual(conceptos[0].codigo, '1000');
  assert.strictEqual(new Set(conceptos.map((c) => c.codigo)).size, conceptos.length);
  assert.ok(conceptos.every((c) => rubros.some((r) => r.codigo === c.codRga)));
  assert.strictEqual(conceptos.find((c) => c.nombre === 'Sueldos y cargas sociales').tipo, 'E');
});

test('sugerencia de concepto: mismo nombre, pistas por palabras y palabra principal', () => {
  const { sugerirConcepto } = require('./gestion/organizar-api');
  const { conceptos } = require('./gestion/conceptos/base').armarBase();
  const cod = (n) => conceptos.find((c) => c.nombre === n).codigo;
  assert.strictEqual(sugerirConcepto('Carnes', conceptos), cod('Carnes'));
  assert.strictEqual(sugerirConcepto('Verduleria', conceptos), cod('Verdulería y frutas'));
  assert.strictEqual(sugerirConcepto('ALQUILER ', conceptos), cod('Alquiler'));
  assert.strictEqual(sugerirConcepto('Edenor SA', conceptos), cod('Luz'));
  assert.strictEqual(sugerirConcepto('Estudio contable Pérez', conceptos), cod('Honorarios'));
  assert.strictEqual(sugerirConcepto('Bebidas sin alcohol', conceptos), cod('Bebidas'));
  assert.strictEqual(sugerirConcepto('Zzzz', conceptos), null);
  assert.strictEqual(sugerirConcepto('', conceptos), null);
});
