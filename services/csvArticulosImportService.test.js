'use strict';

process.env.PDV_MAP_SIN_REFRESCO = '1';
const test = require('node:test');
const assert = require('node:assert');
const { normalizarMapeo } = require('./csvArticulosImportService');

test('mapeo de columnas: acepta { campo: columna } (lo que manda la pantalla) y { columna: campo }', () => {
  assert.deepEqual(normalizarMapeo({ nombre: 'Producto', precio: 'PVP' }), { Producto: 'nombre', PVP: 'precio' });
  assert.deepEqual(normalizarMapeo({ Producto: 'nombre' }), { Producto: 'nombre' });
  assert.deepEqual(normalizarMapeo(null), {});
});
