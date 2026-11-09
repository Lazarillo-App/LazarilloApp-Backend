'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { problemaPassword } = require('./passwordPolicy');

test('regla de contraseña: 10 caracteres, una mayúscula y un número', () => {
  assert.equal(problemaPassword('Corta1'), 'corta');
  assert.equal(problemaPassword('sinmayuscula1'), 'sin_mayuscula');
  assert.equal(problemaPassword('SinNumeroAca'), 'sin_numero');
  assert.equal(problemaPassword('Lazarillo2026'), null);
  assert.equal(problemaPassword('Ñandú12345'), null); // mayúscula con tilde/ñ también cuenta
  assert.equal(problemaPassword(undefined), 'corta');
});
