// middleware/cacheJson.js
const crypto = require('crypto');

const store = new Map(); // key -> { body, etag, exp }

function buildKey(req) {
  // Cache por negocio + URL completa (ruta + query)
  const bizId =
    req.params?.id ||
    req.user?.active_business_id ||
    req.header('x-business-id') ||
    '';
  return `${req.method}:${bizId}:${req.originalUrl}`;
}

function cacheJson(ttlSeconds = 60) {
  return (req, res, next) => {
    // Solo cachea GET
    if (req.method !== 'GET') return next();

    const key = buildKey(req);
    const now = Date.now();
    const hit = store.get(key);

    if (hit && hit.exp > now) {
      // Soporta If-None-Match -> 304
      if (req.headers['if-none-match'] === hit.etag) {
        res.set('ETag', hit.etag);
        res.set('Cache-Control', `public, max-age=${ttlSeconds}`);
        return res.status(304).end();
      }
      res.set('ETag', hit.etag);
      res.set('Cache-Control', `public, max-age=${ttlSeconds}`);
      return res.status(200).json(hit.body);
    }

    // Patch a res.json para guardar la respuesta
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      try {
        const raw = JSON.stringify(body);
        const etag = '"' + crypto.createHash('sha1').update(raw).digest('hex') + '"';
        store.set(key, { body, etag, exp: now + ttlSeconds * 1000 });
        res.set('ETag', etag);
        res.set('Cache-Control', `public, max-age=${ttlSeconds}`);
      } catch (_) { /* no-op si falla hash */ }
      return originalJson(body);
    };

    next();
  };
}

module.exports = { cacheJson };
