// Tablero de tareas del equipo (13/11/2026): validación de lo que se crea o edita.
const test = require('node:test');
const assert = require('node:assert');
const { validarCambios } = require('./tableroService');

test('una tarea nueva necesita título y se recorta', () => {
  assert.strictEqual(validarCambios({}, { nueva: true }).error, 'titulo_vacio');
  assert.strictEqual(validarCambios({ titulo: '   ' }, { nueva: true }).error, 'titulo_vacio');
  assert.deepStrictEqual(validarCambios({ titulo: '  Revisar MP  ' }, { nueva: true }).campos, { titulo: 'Revisar MP' });
  assert.strictEqual(validarCambios({ titulo: 'x'.repeat(500) }, { nueva: true }).campos.titulo.length, 200);
});

test('al editar solo cambia lo que viene, y valida estado, prioridad y asignado', () => {
  assert.deepStrictEqual(validarCambios({ estado: 'hecha' }).campos, { estado: 'hecha' });
  assert.strictEqual(validarCambios({ estado: 'lista' }).error, 'estado_invalido');
  assert.strictEqual(validarCambios({ prioridad: 'urgente' }).error, 'prioridad_invalida');
  assert.deepStrictEqual(validarCambios({ asignado_a: null }).campos, { asignado_a: null });
  assert.deepStrictEqual(validarCambios({ asignado_a: '7' }).campos, { asignado_a: 7 });
  assert.strictEqual(validarCambios({ asignado_a: 'diego' }).error, 'asignado_invalido');
  assert.deepStrictEqual(validarCambios({ detalle: '   ' }).campos, { detalle: null });
  assert.strictEqual(validarCambios({ titulo: '' }).error, 'titulo_vacio');
});

test('el aviso dice en palabras qué se cambió', () => {
  const { describirCambios } = require('./tableroService');
  assert.strictEqual(describirCambios({ estado: 'hecha' }), 'marcó como hecha');
  assert.strictEqual(describirCambios({ asignado_a: 2 }, { asignado_nombre: 'Diego Albo' }), 'le asignó la tarea a Diego');
  assert.strictEqual(describirCambios({ asignado_a: null }), 'dejó la tarea sin asignar');
  assert.strictEqual(describirCambios({ titulo: 'x', detalle: 'y', prioridad: 'alta' }), 'cambió la prioridad a Alta y editó la tarea');
});
