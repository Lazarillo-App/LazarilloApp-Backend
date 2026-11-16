// Token de lectura del tablero para Claude (15/11/2026).
const test = require('node:test');
const assert = require('node:assert');
const r = require('./claudeRoutes');

const BUENO = 'x'.repeat(40);

test('el token vale solo si coincide y el configurado es largo', () => {
  assert.strictEqual(r._tokenValido(BUENO, BUENO), true);
  assert.strictEqual(r._tokenValido(BUENO + 'y', BUENO), false);
  assert.strictEqual(r._tokenValido('', BUENO), false);
  assert.strictEqual(r._tokenValido(undefined, BUENO), false);
  assert.strictEqual(r._tokenValido('corto', 'corto'), false);
  assert.strictEqual(r._tokenValido('', ''), false);
});

function correr(token, header) {
  const viejo = process.env.CLAUDE_TOKEN;
  if (token === undefined) delete process.env.CLAUDE_TOKEN; else process.env.CLAUDE_TOKEN = token;
  const out = { status: 200, siguio: false };
  const res = { status(s) { out.status = s; return this; }, json(b) { out.body = b; return this; }, set() { return this; } };
  r._requireClaudeToken({ get: () => header }, res, () => { out.siguio = true; });
  if (viejo === undefined) delete process.env.CLAUDE_TOKEN; else process.env.CLAUDE_TOKEN = viejo;
  return out;
}

test('sin CLAUDE_TOKEN configurado la ruta no existe', () => {
  assert.deepStrictEqual(correr(undefined, `Bearer ${BUENO}`), { status: 404, siguio: false, body: { error: 'not_found' } });
  assert.strictEqual(correr('corto', 'Bearer corto').status, 404);
});

test('con el token correcto pasa; sin él o con otro, 401', () => {
  assert.strictEqual(correr(BUENO, `Bearer ${BUENO}`).siguio, true);
  assert.strictEqual(correr(BUENO, `bearer  ${BUENO} `).siguio, true);
  assert.strictEqual(correr(BUENO, undefined).status, 401);
  assert.strictEqual(correr(BUENO, `Bearer ${'z'.repeat(40)}`).status, 401);
  assert.strictEqual(correr(BUENO, BUENO).status, 401);
});
