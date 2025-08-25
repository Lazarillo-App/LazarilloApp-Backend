// controllers/ventasController.js
const fetch = require('node-fetch'); // v2

/* ========================= Config ========================= */
const API_BASE   = process.env.MAXI_BASE_URL       || 'https://api-mconn.maxisistemas.com.ar';
const STATS_BASE = process.env.MAXI_STATS_BASE_URL || API_BASE;
const MAXI_TZ    = process.env.MAXI_TZ || 'America/Argentina/Buenos_Aires';
const CACHE_TTL_MS = Number(process.env.VENTAS_CACHE_TTL_MS || (12 * 60 * 60 * 1000)); // 12h

/* ========================= Utils YMD/TZ ========================= */
const ymd = (d) =>
  `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;

const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

const toDateLocal = (ymdStr) => new Date(`${ymdStr}T00:00:00`);

const todayYMDinTZ = (tz) => {
  // "en-CA" -> YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date());
};

const ymdCmp = (a, b) => a === b ? 0 : (a < b ? -1 : 1);

const clampToYesterdayYMD = (toYMD, tz) => {
  const today = todayYMDinTZ(tz);
  // ayer = today - 1 día (en calendario, no por timestamp)
  const d = toDateLocal(today);
  const ayer = ymd(addDays(d, -1));
  return (ymdCmp(toYMD, ayer) > 0) ? ayer : toYMD;
};

const weekLabel = (d) => {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const th = new Date(date); th.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const ys = new Date(Date.UTC(th.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((th - ys) / 86400000) + 1) / 7);
  return `${th.getUTCFullYear()}-W${String(week).padStart(2,'0')}`;
};
const monthLabel = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;

/* ========================= Log (opcional) ========================= */
function logRaw(tag, data) {
  if (process.env.LOG_MAXI_RAW === '1') {
    const ts = new Date().toISOString();
    console.log(`\x1b[36m[LOG_MAXI_RAW]\x1b[0m ${ts} — ${tag}`);
    console.dir(data, { depth: null, colors: true });
    console.log('--------------------------------------------------');
  }
}

/* ========================= Auth cache ========================= */
let tokenCache = { token: null, exp: 0 };

async function getMaxiToken() {
  const now = Date.now();
  if (process.env.MAXI_BEARER_TOKEN?.startsWith('Bearer ')) {
    return process.env.MAXI_BEARER_TOKEN.replace(/^Bearer\s+/, '');
  }
  if (tokenCache.token && tokenCache.exp > now) return tokenCache.token;

  const body = {
    email:   process.env.MAXI_EMAIL,
    pass:    process.env.MAXI_PASS,
    cod_cli: process.env.MAXI_CODCLI,
  };

  const res = await fetch(`${API_BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const text = await res.text().catch(() => '');
  let json; try { json = JSON.parse(text); } catch { json = null; }
  logRaw('LOGIN /login (raw)', json ?? text);

  if (!res.ok || json?.resultCode !== 'SUCCESS') {
    const msg = (json && json.resultDescription) || res.statusText || text || 'login error';
    const err = new Error(`Login MaxiRest ${res.status || ''}: ${msg}`);
    err.status = 502;
    throw err;
  }

  const token = json?.content?.tokenAccess;
  if (!token) {
    const err = new Error('Login MaxiRest: token vacío');
    err.status = 502;
    throw err;
  }

  tokenCache = { token, exp: now + 10 * 60 * 1000 }; // 10 min
  return token;
}

/* ========================= Fetch por rango (máx 7d) ========================= */
async function fetchFullByDate(fromYMD, toYMD, token) {
  const url = new URL(`${STATS_BASE}/estadisticas/fullinvoicebydate`);
  url.searchParams.set('from', fromYMD);
  url.searchParams.set('to', toYMD);

  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });

  const text = await res.text().catch(() => '');
  let data; try { data = JSON.parse(text); } catch { data = null; }
  logRaw(`GET ${url.pathname}?from=${fromYMD}&to=${toYMD} (raw)`, data ?? text);

  if (!res.ok) {
    const msg = (data && data.resultDescription) || res.statusText || text || 'fetch error';
    const err = new Error(`MaxiRest ${res.status}: ${msg}`);
    err.status = 502;
    throw err;
  }
  if (data?.resultCode && data.resultCode !== 'SUCCESS') {
    const err = new Error(`MaxiRest: ${data?.resultDescription || 'error'}`);
    err.status = 502;
    throw err;
  }
  // Algunas respuestas vienen "content.content.content"
  return data?.content ?? data ?? {};
}

/* ========================= Parser leaf + ignoreZero ========================= */
function extractDeepLeafItems(content, targetId, ignoreZero) {
  const out = [];

  const coerceFecha = (obj, parentFecha) => {
    if (!obj || typeof obj !== 'object') return parentFecha;
    for (const k of Object.keys(obj)) {
      if (/^fecha/i.test(k) && typeof obj[k] === 'string') {
        return String(obj[k]).slice(0, 10);
      }
    }
    return parentFecha;
  };

  const pickId     = (n) => n.cod_art ?? n.articuloId ?? n.codigoArticulo ?? n.codigo ?? n.idArticulo ?? n.id;
  const pickQty    = (n) => n.cantidad ?? n.cantidadVendida ?? n.qty ?? n.unidades;
  const pickPrecio = (n) => n.precio ?? n.precioUnit ?? n.importeUnit;

  const walk = (node, parentFecha = null) => {
    if (!node) return false;

    if (Array.isArray(node)) {
      let any = false;
      for (const n of node) { if (walk(n, parentFecha)) any = true; }
      return any;
    }

    if (typeof node === 'object') {
      const fecha = coerceFecha(node, parentFecha);

      // primero hijos
      let childCounted = false;
      for (const v of Object.values(node)) {
        if (v && typeof v === 'object') {
          if (walk(v, fecha)) childCounted = true;
        }
      }

      // luego este nodo (solo si no contó ningún hijo)
      const idRaw  = pickId(node);
      const qtyRaw = pickQty(node);
      const price  = pickPrecio(node);
      const isCandidate = (idRaw != null) && (qtyRaw != null) && !!fecha;

      if (isCandidate && !childCounted) {
        const idNum = Number(idRaw);
        const qNum  = Number(qtyRaw) || 0;
        const pNum  = Number(price);
        if (Number.isFinite(idNum) && idNum === targetId) {
          if (!ignoreZero || pNum > 0) {
            out.push({ fechaYMD: fecha, articuloId: idNum, cantidad: qNum });
            return true;
          }
        }
      }

      return childCounted;
    }

    return false;
  };

  walk(content, null);
  return out;
}

/* ========================= Cache respuesta ========================= */
const responseCache = new Map(); // key -> { exp, data }
const cacheKey = (o) =>
  `${o.articuloId}|${o.from}|${o.to}|${o.groupBy}|${o.ignoreZero?'1':'0'}|${o.tz}`;

const cacheGet = (key) => {
  const hit = responseCache.get(key);
  if (!hit) return null;
  if (hit.exp < Date.now()) { responseCache.delete(key); return null; }
  return hit.data;
};
const cachePut = (key, data) => {
  responseCache.set(key, { exp: Date.now() + CACHE_TTL_MS, data });
};

/* ========================= Handler ========================= */
/**
 * GET /api/ventas?articuloId=...&from=YYYY-MM-DD&to=YYYY-MM-DD&groupBy=day|week|month&ignoreZero=true
 * - Clampea `to` a AYER en TZ (`MAXI_TZ`) para evitar parciales.
 * - Ignora precio 0 por default.
 * - Memoiza respuesta (12h).
 */
async function getVentas(req, res, next) {
  try {
    const articuloId = Number(req.query.articuloId);
    const groupBy = String(req.query.groupBy || 'day').toLowerCase();
    const ignoreZero = String(req.query.ignoreZero ?? 'true') === 'true';
    const tz = MAXI_TZ;

    let fromYMD = String(req.query.from || '').slice(0, 10);
    let toYMD   = String(req.query.to   || '').slice(0, 10);

    if (!Number.isFinite(articuloId) || !fromYMD || !toYMD) {
      return res.status(400).json({ error: 'Parámetros requeridos: articuloId, from, to' });
    }

    // clamp TO a AYER en TZ
    toYMD = clampToYesterdayYMD(toYMD, tz);
    if (ymdCmp(fromYMD, toYMD) > 0) {
      return res.status(400).json({ error: 'Rango de fechas inválido (from > to)' });
    }

    // Cache
    const key = cacheKey({ articuloId, from: fromYMD, to: toYMD, groupBy, ignoreZero, tz });
    const cached = cacheGet(key);
    if (cached) return res.json(cached);

    // Auth
    const token = await getMaxiToken();

    // Iterar por semanas (máx 7 días)
    let cursor = toDateLocal(fromYMD);
    const end  = toDateLocal(toYMD);
    const lines = [];

    while (cursor <= end) {
      const cStart = new Date(cursor);
      const cEnd   = addDays(cursor, 6);
      const stop   = (cEnd < end ? cEnd : end);

      const chunkContent = await fetchFullByDate(ymd(cStart), ymd(stop), token);
      const chunk = extractDeepLeafItems(chunkContent, articuloId, ignoreZero);
      if (chunk.length) lines.push(...chunk);

      cursor = addDays(stop, 1);
    }

    // Agrupar
    const bucket = new Map();
    for (const it of lines) {
      const d = toDateLocal(it.fechaYMD);
      const label =
        groupBy === 'month' ? monthLabel(d) :
        groupBy === 'week'  ? weekLabel(d)  :
        ymd(d); // day
      bucket.set(label, (bucket.get(label) || 0) + it.cantidad);
    }

    const items = Array.from(bucket.entries())
      .sort(([a],[b]) => a.localeCompare(b))
      .map(([label, qty]) => ({ label, qty }));

    const total = items.reduce((acc, x) => acc + x.qty, 0);

    const payload = { total, items, from: fromYMD, to: toYMD };
    cachePut(key, payload);
    return res.json(payload);
  } catch (err) {
    return next(err);
  }
}

module.exports = { getVentas };
