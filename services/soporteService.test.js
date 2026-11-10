'use strict';

process.env.PDV_MAP_SIN_REFRESCO = '1';
const test = require('node:test');
const assert = require('node:assert');
const { validarConfig } = require('./soporteService');

const base = { emails: ['lazarillo.app2025@gmail.com'], whatsapp: '+54 9 11 6398-9934', chat: { saludo: 'Hola', opciones: [{ id: 'duda', texto: 'Tengo una duda', pedido: '¿Cuál?' }] } };

test('config del chat: limpia el WhatsApp y exige un mail válido y una opción', () => {
  assert.equal(validarConfig(base).config.whatsapp, '5491163989934');
  assert.equal(validarConfig({ ...base, emails: [] }).error, 'falta_un_mail');
  assert.match(validarConfig({ ...base, emails: ['no-es-mail'] }).error, /mail_invalido/);
  assert.equal(validarConfig({ ...base, chat: { opciones: [] } }).error, 'falta_una_opcion');
});

test('config del chat: opción con pregunta de opciones o libre', () => {
  const c = validarConfig({ ...base, chat: { opciones: [
    { id: 'tec', texto: 'Problema', pregunta: { texto: '¿Dónde?', opciones: ['A', '', 'B'] } },
    { texto: 'Sin id', pregunta: { texto: '¿Qué POS?', libre: true } },
  ] } }).config;
  assert.deepEqual(c.chat.opciones[0].pregunta.opciones, ['A', 'B']);
  assert.equal(c.chat.opciones[1].id, 'op2');
  assert.equal(c.chat.opciones[1].pregunta.libre, true);
  assert.equal(c.chat.despedida.length > 0, true);
});
