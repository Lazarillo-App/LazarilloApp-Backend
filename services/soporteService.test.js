// Configuración del chat de Anthony y avisos por Telegram (13/11/2026).
const test = require('node:test');
const assert = require('node:assert');
const { validarConfig } = require('./soporteService');
const telegram = require('../utils/telegram');
const { validar } = require('./ajustesService');

const base = {
  emails: ['equipo@x.com'],
  chat: { opciones: [{ id: 'cambio', texto: 'Quiero pedir un cambio', captura: true, tipo: 'pedido' }, { id: 'otra', texto: 'Otra', tipo: 'raro' }] },
  telegram: { chat_ids: ['123456789', '123456789', 'no-es-id', '-1001234567890'] },
};

test('la config conserva captura, tipo y los chats de Telegram válidos', () => {
  const { config } = validarConfig(base);
  assert.strictEqual(config.chat.opciones[0].captura, true);
  assert.strictEqual(config.chat.opciones[0].tipo, 'pedido');
  assert.strictEqual(config.chat.opciones[1].tipo, undefined, 'un tipo desconocido se descarta');
  assert.deepStrictEqual(config.telegram.chat_ids, ['123456789', '-1001234567890']);
});

test('sin token de Telegram no se manda nada y no tira error', async () => {
  const antes = process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_BOT_TOKEN;
  const r = await telegram.avisar(['123'], 'hola');
  assert.deepStrictEqual(r, { enviados: 0, error: 'telegram_sin_token' });
  if (antes !== undefined) process.env.TELEGRAM_BOT_TOKEN = antes;
});

test('con token manda un mensaje por chat', async () => {
  const antes = process.env.TELEGRAM_BOT_TOKEN;
  const fetchAntes = global.fetch;
  process.env.TELEGRAM_BOT_TOKEN = 'TOKEN';
  const llamadas = [];
  global.fetch = async (url, opts) => { llamadas.push({ url, body: JSON.parse(opts.body) }); return { ok: true, json: async () => ({ ok: true, result: {} }) }; };
  try {
    const r = await telegram.avisar(['1', '2', '1'], '<b>Pedido</b>');
    assert.strictEqual(r.enviados, 2);
    assert.ok(llamadas[0].url.endsWith('/botTOKEN/sendMessage'));
    assert.strictEqual(llamadas[0].body.parse_mode, 'HTML');
  } finally {
    global.fetch = fetchAntes;
    if (antes === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = antes;
  }
});

test('ajustes: clave, alcance y a quién se validan', () => {
  assert.strictEqual(validar({ clave: 'aviso_cliente', alcance: 'global', valor: 'hola' }).fila.scope_id, null);
  assert.strictEqual(validar({ clave: 'Con Espacios', alcance: 'global' }).error, 'clave_invalida');
  assert.strictEqual(validar({ clave: 'x1', alcance: 'planeta' }).error, 'alcance_invalido');
  assert.strictEqual(validar({ clave: 'x1', alcance: 'usuario' }).error, 'falta_a_quien');
  assert.strictEqual(validar({ clave: 'x1', alcance: 'usuario', scope_id: 7 }).fila.valor, true);
});
