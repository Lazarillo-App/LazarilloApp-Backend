'use strict';

process.env.PDV_MAP_SIN_REFRESCO = '1';
const test = require('node:test');
const assert = require('node:assert');
const { articuloDesdeM6, insumoDesdeM0, elegirOrden } = require('./maestrosDesdeKit');

const m6 = (o = {}) => ({ cod_rua: '4', rubro: 'SANDWICHES-BURRITOS', cod_sua: '12', subrubro: 'Comida', codigo: '2',
  nombre: 'SANDWICH DEL CESAR ', descripcion: 'Pan ciabatta', precio1: '25600', precio2: '20500', discontinuado: false, ...o });

test('artículo: orden de la API de menú (categoria = rubro)', () => {
  const a = articuloDesdeM6(m6());
  assert.equal(a.articulo_id, 2);
  assert.equal(a.nombre, 'SANDWICH DEL CESAR');
  assert.equal(a.categoria, 'SANDWICHES-BURRITOS');
  assert.equal(a.subrubro, 'Comida');
  assert.equal(a.precio, 25600);
  assert.equal(a.raw.descripc, 'Pan ciabatta');
  assert.equal(a.raw._source, 'kit');
});

test('artículo: orden invertido; vacío → "Sin categoría" / "Sin subrubro" (como la sync manual)', () => {
  const a = articuloDesdeM6(m6({ subrubro: null }), 'rubro_subrubro');
  assert.equal(a.subrubro, 'SANDWICHES-BURRITOS');
  assert.equal(a.categoria, 'Sin categoría');
  assert.equal(articuloDesdeM6(m6({ subrubro: '' })).subrubro, 'Sin subrubro');
});

test('artículo: sin código o sin nombre se descarta; discontinuado se marca', () => {
  assert.equal(articuloDesdeM6(m6({ codigo: '0' })), null);
  assert.equal(articuloDesdeM6(m6({ nombre: '  ' })), null);
  assert.equal(articuloDesdeM6(m6({ discontinuado: 'true' })).discontinuado, true);
  assert.equal(articuloDesdeM6(m6({ precio1: null })).precio, 0);
});

test('insumo: forma de upsertFromMaxi, rubro = cod_rui, precio 0 no cuenta', () => {
  const i = insumoDesdeM0({ cod_rui: '711', rubro: 'sin alcohol', codigo: '5', nombre: 'hielo', unidad_med: 'K', precio: '253.333', discontinuado: false });
  assert.deepEqual(i, { codigo_maxi: '5', nombre: 'hielo', rubro: '711', unidad_med: 'K', precio_ref: 253.333, maxi_discontinuado: false });
  assert.equal(insumoDesdeM0({ codigo: '3', nombre: 'Licor', precio: '0.0' }).precio_ref, null);
  assert.equal(insumoDesdeM0({ codigo: '3.0', nombre: 'Licor' }).codigo_maxi, '3');
  assert.equal(insumoDesdeM0({ codigo: null, nombre: 'x' }), null);
});

test('orden: gana el que más coincide con lo que ya tiene el negocio; sin datos, intercambiado', () => {
  const filas = [m6(), m6({ codigo: '3', rubro: 'PIZZAS', subrubro: 'Comida' })];
  assert.equal(elegirOrden([{ articulo_id: 2, categoria_maxi: 'comida' }, { articulo_id: 3, categoria_maxi: 'Comida' }], filas).orden, 'rubro_subrubro');
  assert.equal(elegirOrden([{ articulo_id: 2, categoria_maxi: 'SANDWICHES-BURRITOS' }], filas).orden, 'rubro_categoria');
  assert.equal(elegirOrden([], filas).orden, 'rubro_subrubro');
  assert.equal(elegirOrden([], filas, { invertirJerarquia: true }).orden, 'rubro_categoria');
});
