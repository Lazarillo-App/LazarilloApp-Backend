// Logos al completar el alta: una página de plataforma (Waitry, Fudo…) no aporta su
// propio ícono como logo del local (usuaria 11/11: le traía el logo de Waitry).
const test = require('node:test');
const assert = require('node:assert');
const { _leerWeb: leerWeb, _plataformaDe: plataformaDe } = require('./completarNegocioController');

function conHtml(html, url) {
  const original = global.fetch;
  global.fetch = async () => ({
    ok: true,
    url,
    headers: { get: () => 'text/html; charset=utf-8' },
    text: async () => html,
  });
  return () => { global.fetch = original; };
}

test('plataformaDe reconoce menús digitales y redes, no webs propias', () => {
  assert.strictEqual(plataformaDe('https://menu.waitry.net/bar-x'), 'waitry');
  assert.strictEqual(plataformaDe('https://www.instagram.com/barx'), 'instagram.com');
  assert.strictEqual(plataformaDe('https://www.containerbar.com.ar/'), '');
  assert.strictEqual(plataformaDe('no es url'), '');
});

test('página de Waitry: sin íconos de Waitry, con la imagen del local', async () => {
  const html = `<html><head>
    <link rel="icon" href="/favicon-32.png">
    <link rel="apple-touch-icon" href="https://cdn.waitry.net/static/waitry-icon.png">
    <meta property="og:image" content="https://cdn.waitry.net/stores/123/bar-x.jpg">
  </head><body><img class="logo" src="https://cdn.waitry.net/static/waitry-logo.svg">
  <a href="https://www.instagram.com/barx/">ig</a></body></html>`;
  const restaurar = conHtml(html, 'https://menu.waitry.net/bar-x');
  try {
    const r = await leerWeb('https://menu.waitry.net/bar-x');
    assert.deepStrictEqual(r.logos, ['https://cdn.waitry.net/stores/123/bar-x.jpg']);
    assert.strictEqual(r.instagram, 'https://www.instagram.com/barx/');
  } finally { restaurar(); }
});

test('web propia: sigue tomando íconos y og:image como antes', async () => {
  const html = `<html><head>
    <link rel="apple-touch-icon" href="/apple-touch-icon.png">
    <meta property="og:image" content="/portada.jpg">
  </head><body><img src="/img/logo-bar.png"></body></html>`;
  const restaurar = conHtml(html, 'https://www.barx.com.ar/');
  try {
    const r = await leerWeb('https://www.barx.com.ar/');
    assert.deepStrictEqual(r.logos, [
      'https://www.barx.com.ar/apple-touch-icon.png',
      'https://www.barx.com.ar/img/logo-bar.png',
      'https://www.barx.com.ar/portada.jpg',
    ]);
  } finally { restaurar(); }
});
