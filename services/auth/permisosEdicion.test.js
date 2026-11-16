// Guardia de escritura por sección (tablero #45, 16/11/2026): Recetas en roles a medida.
const test = require('node:test');
const assert = require('node:assert');
const { requireEdicionSeccion } = require('./permisos');

function correr(mw, { method, path = '/', permisos }) {
  const out = { status: 200, siguio: false };
  const res = { status(s) { out.status = s; return this; }, json(b) { out.body = b; return this; } };
  mw({ method, path, permisos }, res, () => { out.siguio = true; });
  return out;
}

const guardia = requireEdicionSeccion('recetas', { lecturas: ['/insumos-usados'] });
const rol = (recetas) => ({ secciones: recetas ? { recetas } : {}, ocultos: [] });

test('sin rol a medida (dueño, admin completo, staff) pasa todo', () => {
  for (const method of ['GET', 'POST', 'PUT', 'DELETE']) assert.ok(correr(guardia, { method, permisos: null }).siguio);
});

test('las lecturas pasan aunque el rol no vea Recetas', () => {
  assert.ok(correr(guardia, { method: 'GET', permisos: rol(null) }).siguio);
  assert.ok(correr(guardia, { method: 'POST', path: '/insumos-usados', permisos: rol(null) }).siguio);
});

test('escribir necesita Recetas en «editar»', () => {
  assert.ok(correr(guardia, { method: 'POST', permisos: rol('editar') }).siguio);
  const ver = correr(guardia, { method: 'PUT', permisos: rol('ver') });
  assert.strictEqual(ver.status, 403);
  assert.deepStrictEqual(ver.body, { error: 'sin_permiso', seccion: 'recetas', modo: 'editar' });
  assert.strictEqual(correr(guardia, { method: 'DELETE', permisos: rol(null) }).status, 403);
  assert.strictEqual(correr(guardia, { method: 'POST', path: '/bulk-add-insumo', permisos: rol('ver') }).status, 403);
});
