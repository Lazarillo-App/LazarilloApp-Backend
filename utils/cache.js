// utils/cache.js
const cache = new Map(); // key -> { data, expireAt, inflight }

function get(key) {
  const x = cache.get(key);
  if (!x) return null;
  if (x.expireAt && x.expireAt < Date.now()) { cache.delete(key); return null; }
  return x;
}

async function cached(key, loader, ttlMs = 300_000) {
  const hit = get(key);
  if (hit?.data) return hit.data;
  if (hit?.inflight) return await hit.inflight;

  const p = Promise.resolve().then(loader).then((data) => {
    cache.set(key, { data, expireAt: Date.now() + ttlMs, inflight: null });
    return data;
  }).finally(() => {
    const cur = cache.get(key);
    if (cur) cur.inflight = null;
  });

  cache.set(key, { data: null, expireAt: 0, inflight: p });
  return await p;
}

const makeKey = (...parts) => parts.join('|');
module.exports = { cached, makeKey };
