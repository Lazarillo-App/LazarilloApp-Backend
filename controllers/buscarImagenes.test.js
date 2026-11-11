const test = require('node:test');
const assert = require('node:assert');
const { buscar, bajar } = require('./buscarImagenesController');

function resFalso() {
  const r = { statusCode: 200, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}

test('sin BRAVE_SEARCH_API_KEY responde 501 (el asistente esconde la opción)', async () => {
  const antes = process.env.BRAVE_SEARCH_API_KEY;
  delete process.env.BRAVE_SEARCH_API_KEY;
  const res = resFalso();
  await buscar({ query: { q: 'buffet comercio logo' } }, res);
  assert.strictEqual(res.statusCode, 501);
  if (antes !== undefined) process.env.BRAVE_SEARCH_API_KEY = antes;
});

test('devuelve solo miniaturas de Brave', async () => {
  const antes = process.env.BRAVE_SEARCH_API_KEY;
  const fetchAntes = global.fetch;
  process.env.BRAVE_SEARCH_API_KEY = 'prueba';
  let pedido = '';
  global.fetch = async (url, opts) => {
    pedido = url;
    assert.strictEqual(opts.headers['X-Subscription-Token'], 'prueba');
    return {
      ok: true,
      json: async () => ({
        results: [
          { title: 'Buffet Comercio (@buffet.comercio)', thumbnail: { src: 'https://imgs.search.brave.com/abc' }, meta_url: { hostname: 'www.instagram.com' } },
          { title: 'raro', thumbnail: { src: 'https://otro.com/x.png' } },
          { title: 'sin miniatura' },
        ],
      }),
    };
  };
  try {
    const res = resFalso();
    await buscar({ query: { q: 'buffet comercio logo' } }, res);
    assert.ok(pedido.includes('q=buffet+comercio+logo'));
    assert.deepStrictEqual(res.body.imagenes, [
      { thumb: 'https://imgs.search.brave.com/abc', fuente: 'www.instagram.com', titulo: 'Buffet Comercio (@buffet.comercio)' },
    ]);
  } finally {
    global.fetch = fetchAntes;
    if (antes === undefined) delete process.env.BRAVE_SEARCH_API_KEY; else process.env.BRAVE_SEARCH_API_KEY = antes;
  }
});

test('bajar rechaza URLs que no son miniaturas de Brave', async () => {
  for (const url of ['http://imgs.search.brave.com/a', 'https://evil.com/a.png', 'file:///etc/passwd', '']) {
    const res = resFalso();
    await bajar({ query: { url } }, res);
    assert.strictEqual(res.statusCode, 400, url);
  }
});
