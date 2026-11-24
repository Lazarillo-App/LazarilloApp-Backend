'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { _puros: p } = require('./produccionNovedades');

test('normalizarTipo reconoce los 5 tipos de novedad por clave o etiqueta', () => {
  assert.equal(p.normalizarTipo('danado'), 'danado');
  assert.equal(p.normalizarTipo('Algo dañado'), 'danado');
  assert.equal(p.normalizarTipo('sucio'), 'sucio');
  assert.equal(p.normalizarTipo('Algo sucio'), 'sucio');
  assert.equal(p.normalizarTipo('limpieza'), 'limpieza');
  assert.equal(p.normalizarTipo('Se hizo limpieza'), 'limpieza');
  assert.equal(p.normalizarTipo('estado'), 'estado');
  assert.equal(p.normalizarTipo('Cómo quedó algo'), 'estado');
  assert.equal(p.normalizarTipo('otro'), 'otro');
  assert.equal(p.normalizarTipo('Otro'), 'otro');
  assert.equal(p.normalizarTipo(''), null);
  assert.equal(p.normalizarTipo('inexistente'), null);
});

test('exigirDuenoOAdmin permite dueño/admin y rechaza con 403 a cocinero y jefe de cocina', () => {
  assert.doesNotThrow(() => p.exigirDuenoOAdmin({ gestor: true, jefe: false, rol: 'owner' }));
  assert.doesNotThrow(() => p.exigirDuenoOAdmin({ gestor: true, jefe: false, rol: 'admin' }));
  assert.throws(
    () => p.exigirDuenoOAdmin({ gestor: false, jefe: true, planifica: true, rol: 'staff' }),
    (err) => err.status === 403 && err.code === 'forbidden'
  );
  assert.throws(
    () => p.exigirDuenoOAdmin({ gestor: false, jefe: false, planifica: false, rol: 'staff' }),
    (err) => err.status === 403 && err.code === 'forbidden'
  );
});

test('formatoNovedad normaliza campos y estado vista', () => {
  const f = p.formatoNovedad({
    id: '15',
    tipo: 'limpieza',
    texto: 'Se desengrasó la campana',
    foto_url: 'https://res.cloudinary.com/demo/image/upload/v1/foto.jpg',
    user_id: '7',
    usuario: 'Ana',
    vista_at: '2026-11-24T18:00:00Z',
    vista_por: '2',
    vista_por_nombre: 'Mairene',
    created_at: '2026-11-24T17:00:00Z',
  });
  assert.equal(f.id, 15);
  assert.equal(f.tipo, 'limpieza');
  assert.equal(f.tipo_label, 'Se hizo limpieza');
  assert.equal(f.vista, true);
  assert.equal(f.vista_por, 'Mairene');
  assert.equal(f.user_id, 7);
});
