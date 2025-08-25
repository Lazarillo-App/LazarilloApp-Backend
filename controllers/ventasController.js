// controllers/ventasController.js
const fetch = require('node-fetch'); // v2

// ==================== Bases ====================
const API_BASE   = process.env.MAXI_BASE_URL       || 'https://api-mconn.maxisistemas.com.ar';
const STATS_BASE = process.env.MAXI_STATS_BASE_URL || API_BASE;

// ==================== Utils fechas ====================
const toDate  = (s) => new Date(`${s}T00:00:00`);
const fmtYMD  = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const addDays = (d,n) => { const x = new Date(d); x.setDate(x.getDate()+n); return x; };

const startOfToday = () => {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
};
const clampToYesterday = (d) => (d >= startOfToday() ? addDays(startOfToday(), -1) : d);

const weekLabel = (d) => {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const th = new Date(date); th.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const ys = new Date(Date.UTC(th.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((th - ys) / 86400000) + 1) / 7);
  return `${th.getUTCFullYear()}-W${String(week).padStart(2,'0')}`;
};
const monthLabel = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;

// ==================== Log crudo opcional ====================
function logRaw(tag, data) {
  if (process.env.LOG_MAXI_RAW === '1') {
    const ts = new Date().toISOString();
    console.log(`\x1b[36m[LOG_MAXI_RAW]\x1b[0m ${ts} — ${tag}`);
    console.dir(data, { depth: null, colors: true });
    console.log('--------------------------------------------------');
  }
}

// ==================== Login con cache ====================
let tokenCache = { token: null, exp: 0, source: 'none' };

/** Hace login SIEMPRE con email/pass/cod_cli (ignora token por env). */
async function loginMaxi() {
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

  tokenCache = { token, exp: Date.now() + 10 * 60 * 1000, source: 'login' }; // 10 min
  return token;
}

/** Devuelve un token: usa env si existe (“Bearer ...”), sino cache o login. */
async function getMaxiToken() {
  const now = Date.now();

  if (process.env.MAXI_BEARER_TOKEN && process.env.MAXI_BEARER_TOKEN.startsWith('Bearer ')) {
    const t = process.env.MAXI_BEARER_TOKEN.replace(/^Bearer\s+/, '');
    tokenCache = { token: t, exp: now + 5 * 60 * 1000, source: 'env' }; // vida corta
    return t;
  }

  if (tokenCache.token && tokenCache.exp > now) return tokenCache.token;

  return await loginMaxi();
}

// ==================== Fetch por semana (+ detección 401) ====================
async function fetchFullByDateRaw(fromYMD, toYMD, token) {
  const url = new URL(`${STATS_BASE}/estadisticas/fullinvoicebydate`);
  url.searchParams.set('from', fromYMD);
  url.searchParams.set('to', toYMD);

  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
  const text = await res.text().catch(() => '');
  let data; try { data = JSON.parse(text); } catch { data = null; }
  logRaw(`GET ${url.pathname}?from=${fromYMD}&to=${toYMD} (raw)`, data ?? text);

  // HTTP 401 real
  if (res.status === 401) {
    const err = new Error('UNAUTHORIZED (HTTP 401)');
    err.status = 401;
    throw err;
  }

  // En muchos casos devuelven 200 con resultCode=UNAUTHORIZED_ACCESS
  if (data?.resultCode && data.resultCode !== 'SUCCESS') {
    const err = new Error(`MaxiRest: ${data?.resultDescription || data?.resultCode || 'error'}`);
    err.status = (data.resultCode === 'UNAUTHORIZED_ACCESS' ? 401 : 502);
    throw err;
  }

  if (!res.ok) {
    const msg = (data && data.resultDescription) || res.statusText || text || 'fetch error';
    const err = new Error(`MaxiRest ${res.status}: ${msg}`);
    err.status = res.status || 502;
    throw err;
  }

  // Suele venir como { content: {...} }
  return data?.content ?? data ?? {};
}

/** Wrapper con re-login automático si vino 401/UNAUTHORIZED_ACCESS. */
async function fetchFullByDate(fromYMD, toYMD) {
  let token = await getMaxiToken();
  try {
    return await fetchFullByDateRaw(fromYMD, toYMD, token);
  } catch (e) {
    if (e.status === 401) {
      console.warn('[ventasController] Token rechazado, re-login y retry una vez...');
      // si el token venía de ENV, intentamos login real
      await loginMaxi();
      token = tokenCache.token;
      return await fetchFullByDateRaw(fromYMD, toYMD, token);
    }
    throw e;
  }
}

// ==================== Parser “leaf-only” ====================
function extractLeafLinesAll(content) {
  const out = [];

  const coerceFecha = (obj, parentFecha) => {
    if (!obj || typeof obj !== 'object') return parentFecha;
    for (const k of Object.keys(obj)) {
      if (/^fecha/i.test(k) && typeof obj[k] === 'string') {
        const raw = String(obj[k]);
        if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0,10);
        const m = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
        if (m) return `${m[3]}-${m[2]}-${m[1]}`;
        return raw.slice(0,10);
      }
    }
    return parentFecha;
  };

  const pickId  = (n) => n.cod_art ?? n.articuloId ?? n.codigoArticulo ?? n.codigo ?? n.idArticulo ?? n.id;
  const pickQty = (n) => n.cantidad ?? n.cantidadVendida ?? n.qty ?? n.unidades;

  const walk = (node, parentFecha = null) => {
    if (!node) return;

    if (Array.isArray(node)) {
      for (const n of node) walk(n, parentFecha);
      return;
    }

    if (typeof node === 'object') {
      const fecha = coerceFecha(node, parentFecha);

      const idRaw  = pickId(node);
      const qtyRaw = pickQty(node);
      if (idRaw != null && qtyRaw != null && fecha) {
        const idNum = Number(idRaw);
        const qNum  = Number(qtyRaw) || 0;
        if (Number.isFinite(idNum)) {
          out.push({ fechaYMD: fecha, articuloId: idNum, cantidad: qNum });
        }
      }

      for (const v of Object.values(node)) {
        if (v && typeof v === 'object') walk(v, fecha);
      }
    }
  };

  walk(content, null);
  return out;
}

// ============================= Handler =============================
/**
 * GET /api/ventas?articuloId=...&from=YYYY-MM-DD&to=YYYY-MM-DD&groupBy=day|week|month&peek=1
 * - Clampea “to” a AYER para evitar parciales.
 * - peek=1 ignora articuloId y devuelve histograma por artículo en el rango (diagnóstico).
 */
async function getVentas(req, res, next) {
  try {
    const groupBy = String(req.query.groupBy || 'day').toLowerCase();
    const peek    = String(req.query.peek || '0') === '1';

    const from = req.query.from;
    const to   = req.query.to;

    if (!from || !to) {
      return res.status(400).json({ error: 'Parámetros requeridos: from, to' });
    }

    const start = toDate(from);
    let end     = clampToYesterday(toDate(to));

    if (Number.isNaN(start) || Number.isNaN(end) || start > end) {
      return res.status(400).json({ error: 'Rango de fechas inválido (to se clampa a AYER)' });
    }

    // Iterar por semanas cerradas [cursor..stop]
    let cursor = new Date(start);
    const lines = [];

    while (cursor <= end) {
      const cStart = new Date(cursor);
      const cEnd   = addDays(cursor, 6);
      const stop   = (cEnd < end ? cEnd : end);

      const content = await fetchFullByDate(fmtYMD(cStart), fmtYMD(stop));
      const chunk   = extractLeafLinesAll(content);
      if (chunk.length) lines.push(...chunk);

      cursor = addDays(stop, 1);
    }

    // ======= Diagnóstico =======
    if (peek) {
      const hist = new Map();
      for (const it of lines) hist.set(it.articuloId, (hist.get(it.articuloId) || 0) + it.cantidad);
      const top = Array.from(hist.entries())
        .sort((a,b) => b[1] - a[1])
        .slice(0, 50)
        .map(([articuloId, qty]) => ({ articuloId, qty }));

      return res.json({
        from: fmtYMD(start),
        to:   fmtYMD(end),
        uniqueIds: hist.size,
        totalItems: lines.length,
        top
      });
    }

    // ======= Modo normal (requiere articuloId) =======
    const articuloId = Number(req.query.articuloId);
    if (!Number.isFinite(articuloId)) {
      return res.status(400).json({ error: 'articuloId inválido (o usa peek=1 para diagnóstico)' });
    }

    const filtered = lines.filter(it => it.articuloId === articuloId);

    const bucket = new Map();
    for (const it of filtered) {
      const d = toDate(it.fechaYMD);
      const label =
        groupBy === 'month' ? monthLabel(d) :
        groupBy === 'week'  ? weekLabel(d)  :
        fmtYMD(d);
      bucket.set(label, (bucket.get(label) || 0) + it.cantidad);
    }

    const items = Array.from(bucket.entries())
      .sort(([a],[b]) => a.localeCompare(b))
      .map(([label, qty]) => ({ label, qty }));

    const total = items.reduce((acc, x) => acc + x.qty, 0);

    return res.json({ total, items });
  } catch (err) {
    return next(err);
  }
}

module.exports = { getVentas };
