// Configuración del chat de Anthony y avisos por Telegram (13/11/2026).
const test = require('node:test');
const assert = require('node:assert');
const { validarConfig } = require('./soporteService');
const telegram = require('../utils/telegram');
const { validar } = require('./ajustesService');

process.env.PDV_MAP_SIN_REFRESCO = '1';

// ── Tests previos (10/11), recuperados ──
const base0 = { emails: ['lazarillo.app2025@gmail.com'], whatsapp: '+54 9 11 6398-9934', chat: { saludo: 'Hola', opciones: [{ id: 'duda', texto: 'Tengo una duda', pedido: '¿Cuál?' }] } };

test('config del chat: limpia el WhatsApp y exige un mail válido y una opción', () => {
  assert.equal(validarConfig(base0).config.whatsapp, '5491163989934');
  assert.equal(validarConfig({ ...base0, emails: [] }).error, 'falta_un_mail');
  assert.match(validarConfig({ ...base0, emails: ['no-es-mail'] }).error, /mail_invalido/);
  assert.equal(validarConfig({ ...base0, chat: { opciones: [] } }).error, 'falta_una_opcion');
});

test('config del chat: opción con pregunta de opciones o libre', () => {
  const c = validarConfig({ ...base0, chat: { opciones: [
    { id: 'tec', texto: 'Problema', pregunta: { texto: '¿Dónde?', opciones: ['A', '', 'B'] } },
    { texto: 'Sin id', pregunta: { texto: '¿Qué POS?', libre: true } },
  ] } }).config;
  assert.deepEqual(c.chat.opciones[0].pregunta.opciones, ['A', 'B']);
  assert.equal(c.chat.opciones[1].id, 'op2');
  assert.equal(c.chat.opciones[1].pregunta.libre, true);
  assert.equal(c.chat.despedida.length > 0, true);
});

// ── 13/11: captura, tipo, Telegram y ajustes ──

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
