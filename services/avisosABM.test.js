// Avisos de ABM (tablero #51): qué pedido avisa y cómo se arma el texto.
const test = require('node:test');
const assert = require('node:assert');
const { _reglaDe: regla, _textoConteo: texto } = require('./avisosABM');

const de = (m, u) => regla(m, u)?.uno ?? null;

test('agrupaciones: crear, editar, borrar y mover avisan; lo automático no', () => {
  assert.strictEqual(de('POST', '/api/businesses/12/agrupaciones'), 'agrupación creada');
  assert.strictEqual(de('PUT', '/api/businesses/12/agrupaciones/55'), 'agrupación editada');
  assert.strictEqual(de('DELETE', '/api/businesses/12/agrupaciones/55'), 'agrupación borrada');
  assert.strictEqual(de('PUT', '/api/businesses/12/agrupaciones/55/articulos'), 'artículo sumado a una agrupación');
  assert.strictEqual(de('DELETE', '/api/businesses/12/agrupaciones/55/articulos/9'), 'artículo sacado de una agrupación');
  assert.strictEqual(de('POST', '/api/businesses/12/agrupaciones/move-cross-biz'), 'artículo movido de agrupación');
  assert.strictEqual(de('PUT', '/api/businesses/12/agrupaciones/todo'), null);
  assert.strictEqual(de('PUT', '/api/businesses/12/agrupaciones/top20'), null);
  assert.strictEqual(de('POST', '/api/businesses/12/agrupaciones/articulos/origenes'), null);
  assert.strictEqual(de('GET', '/api/businesses/12/agrupaciones'), null);
});

test('artículos, precios, insumos, gestión y configuración; lo que ya avisaba queda afuera', () => {
  assert.strictEqual(de('PATCH', '/api/businesses/12/articles/77'), 'artículo editado');
  assert.strictEqual(de('POST', '/api/businesses/12/articles/manual'), null); // ya avisa
  assert.strictEqual(de('DELETE', '/api/businesses/12/articles/77'), null); // ya avisa
  assert.strictEqual(de('POST', '/api/businesses/12/article-price-config/bulk'), 'precio nuevo cargado');
  assert.strictEqual(de('PUT', '/api/insumos/31?businessId=12'), 'insumo editado');
  assert.strictEqual(de('POST', '/api/insumos'), null); // alta manual ya avisa
  assert.strictEqual(de('DELETE', '/api/insumos/31/manual'), null); // ya avisa
  assert.strictEqual(de('DELETE', '/api/insumos/31/mermas/4'), null); // ya avisa
  assert.strictEqual(de('POST', '/api/insumos/groups/8/items/bulk'), 'insumo sumado a un grupo');
  assert.strictEqual(de('POST', '/api/businesses/12/gestion/facturas'), 'factura cargada');
  assert.strictEqual(de('DELETE', '/api/businesses/12/gestion/facturas/abc-1'), 'factura borrada');
  assert.strictEqual(de('POST', '/api/businesses/12/gestion/facturas/proveedores'), 'proveedor creado');
  assert.strictEqual(de('PATCH', '/api/businesses/12/gestion/pagos-proveedor/5'), 'pago a proveedor editado');
  assert.strictEqual(de('PATCH', '/api/businesses/12/config-costeo'), 'configuración de costeo cambiada');
  assert.strictEqual(de('PATCH', '/api/businesses/12'), null); // datos del negocio ya avisa
  assert.strictEqual(de('POST', '/api/team/invitations'), null); // equipo ya avisa
});

test('texto del aviso: lo más repetido primero, singular y plural', () => {
  assert.strictEqual(texto({
    a: { n: 1, uno: 'rubro renombrado', varios: 'rubros renombrados' },
    b: { n: 3, uno: 'artículo editado', varios: 'artículos editados' },
  }), '3 artículos editados, 1 rubro renombrado');
});
