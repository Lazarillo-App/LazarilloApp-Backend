'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { armarFacturasCosteo, proveedorNumerico, claveDesdeComprobante, BASE_PROVEEDOR_PANEL } = require('./puente-costos');

const linea = (o = {}) => ({
  esInsumo: true, codigo: '100', nombre: 'COCA', medida: 'UN', cantidad: 10, totalIns: 6000, ivaTot: 1260, impNtTot: 0,
  tasa: 21, fecha: '2026-11-01', codCga: '10', nomCga: 'Mercaderia', puntoDeVentaId: -147, ...o,
});
const fila = (o = {}) => ({ puntoDeVentaId: -147, per1: 0, per2: 0, per3: 0, impInt: 0, ...o });
const branchDe = new Map([[-147, null], [15, 15]]);
const armar = (lineas, filas = [fila()], extra = {}) => armarFacturasCosteo({
  armado: { lineas, filas }, branchDe, factores: new Map([[100, new Map([['X6', 6]])]]), signo: 1, claveFactura: 'A-2-1~501', proveedorId: 501, ...extra,
});

test('precio unitario desde el neto de la línea', () => {
  const [{ factura }] = armar([linea()]);
  assert.equal(factura.items[0].precio, 600);
  assert.equal(factura.items[0].cantidad, 10);
  assert.equal(factura.items[0].insumo, '100');
});

test('envase: cantidad y precio quedan en unidad base, el total no cambia', () => {
  const [{ factura }] = armar([linea({ medida: 'X6', cantidad: 8, totalIns: 30000 })]);
  assert.equal(factura.items[0].cantidad, 48);
  assert.equal(factura.items[0].precio, 625);
  assert.equal(factura.items[0].preciotot, 30000);
});

test('un envase que no está en el maestro no multiplica', () => {
  const [{ factura }] = armar([linea({ medida: 'X99' })]);
  assert.equal(factura.items[0].cantidad, 10);
});

test('bonificado: suma cantidad con importe cero', () => {
  const [{ factura }] = armar([linea({ cantidad: 1, totalIns: 0, ivaTot: 0 })]);
  assert.equal(factura.items[0].cantidad, 1);
  assert.equal(factura.items[0].precio, 0);
  assert.equal(factura.items[0].insumo, '100');
});

test('concepto: nunca apunta a un insumo aunque el código coincida', () => {
  const [{ factura }] = armar([linea({ esInsumo: false, codigo: '100', medida: null, cantidad: 1 })]);
  assert.equal(factura.items[0].insumo, null);
});

test('insumo con código no numérico queda sin insumo', () => {
  const [{ factura }] = armar([linea({ codigo: 'Texto libre' })]);
  assert.equal(factura.items[0].insumo, null);
});

test('nota de crédito: cantidad e importes en negativo, precio positivo', () => {
  const [{ factura }] = armar([linea({ cantidad: 2, totalIns: 1000, ivaTot: 210 })], [fila()], { signo: -1 });
  const it = factura.items[0];
  assert.equal(it.cantidad, -2);
  assert.equal(it.preciotot, -1000);
  assert.equal(it.iva_total, -210);
  assert.equal(it.precio, 500);
});

test('reparto: una factura por sucursal', () => {
  const r = armar([linea({ puntoDeVentaId: -147, cantidad: 6, totalIns: 600 }), linea({ puntoDeVentaId: 15, cantidad: 4, totalIns: 400 })]);
  assert.deepEqual(r.map((x) => x.branchId), [null, 15]);
  assert.equal(r[1].factura.items[0].sucursal, 15);
});

test('percepciones e imp. internos generales van al primer renglón', () => {
  const [{ factura }] = armar([linea({ impNtTot: 10 }), linea()], [fila({ per1: 12.34, per2: 5, impInt: 13 })]);
  assert.equal(factura.items[0].percep, 17.34);
  assert.equal(factura.items[0].imp_inttot, 13);
  assert.equal(factura.items[1].percep, 0);
});

test('proveedor: numérico tal cual, L<n> fuera del rango de MaxiRest, otro sin id', () => {
  assert.equal(proveedorNumerico('501'), 501);
  assert.equal(proveedorNumerico('L3'), BASE_PROVEEDOR_PANEL + 3);
  assert.equal(proveedorNumerico('9999X'), null);
});

test('clave: sin ceros, con proveedor; tickets también con fecha; NC sin letra', () => {
  assert.equal(claveDesdeComprobante('A000200001234', '501', '2026-11-01'), 'A-2-1234~501');
  assert.equal(claveDesdeComprobante('Z000200000077', '501', '2026-11-01'), 'Z-2-77~501~2026-11-01');
  assert.equal(claveDesdeComprobante('NCA000200000005', '501'), 'NC-2-5~501');
  assert.equal(claveDesdeComprobante('raro', '501'), null);
});
