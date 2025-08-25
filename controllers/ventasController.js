const fetch = require('node-fetch'); // v2

const API_BASE   = process.env.MAXI_BASE_URL       || 'https://api-mconn.maxisistemas.com.ar';
const STATS_BASE = process.env.MAXI_STATS_BASE_URL || API_BASE;

// ========== Utils fechas ==========
const toDate  = (s) => new Date(`${s}T00:00:00`);
const fmtYMD  = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const addDays = (d,n) => { const x = new Date(d); x.setDate(x.getDate()+n); return x; };

const weekLabel = (d) => {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const th = new Date(date); th.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const ys = new Date(Date.UTC(th.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((th - ys) / 86400000) + 1) / 7);
  return `${th.getUTCFullYear()}-W${String(week).padStart(2,'0')}`;
};
const monthLabel = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;

// (opcional) log crudo
function logRaw(tag, data) {
  if (process.env.LOG_MAXI_RAW === '1') {
    const ts = new Date().toISOString();
    console.log(`\x1b[36m[LOG_MAXI_RAW]\x1b[0m ${ts} — ${tag}`);
    console.dir(data, { depth: null, colors: true });
    console.log('--------------------------------------------------');
  }
}

// ========== Login cache ==========
let tokenCache = { token: null, exp: 0 };

async function getMaxiToken() {
  const now = Date.now();

  // Token fijo por env (si existe)
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

// ========== Fetch por semana ==========
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

  return data?.content ?? data ?? {};
}

// ========== Parser: contar SOLO hojas (leaf) ==========
function extractDeepLeafItems(content, targetId) {
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

  const pickId = (n) =>
    n.cod_art ?? n.articuloId ?? n.codigoArticulo ?? n.codigo ?? n.idArticulo ?? n.id;

  const pickQty = (n) =>
    n.cantidad ?? n.cantidadVendida ?? n.qty ?? n.unidades;

  // devuelve true si en este subárbol se contó al menos un candidato
  const walk = (node, parentFecha = null) => {
    if (!node) return false;

    // arrays: acumular hijos
    if (Array.isArray(node)) {
      let any = false;
      for (const n of node) { if (walk(n, parentFecha)) any = true; }
      return any;
    }

    if (typeof node === 'object') {
      const fecha = coerceFecha(node, parentFecha);

      // primero procesamos hijos
      let childCounted = false;
      for (const v of Object.values(node)) {
        if (v && typeof v === 'object') {
          if (walk(v, fecha)) childCounted = true;
        }
      }

      // luego evaluamos ESTE nodo
      const idRaw  = pickId(node);
      const qtyRaw = pickQty(node);
      const isCandidate = (idRaw != null) && (qtyRaw != null) && !!fecha;

      if (isCandidate && !childCounted) {
        const idNum = Number(idRaw);
        const qNum  = Number(qtyRaw) || 0;
        if (Number.isFinite(idNum) && idNum === targetId) {
          out.push({ fechaYMD: fecha, articuloId: idNum, cantidad: qNum });
          return true; // este nodo contó
        }
      }

      return childCounted;
    }

    return false;
  };

  walk(content, null);
  return out;
}

/* ============================= Handler ============================= */
/**
 * GET /api/ventas?articuloId=...&from=YYYY-MM-DD&to=YYYY-MM-DD&groupBy=day|week|month
 * Clampea SIEMPRE el “to” a AYER (medianoche local del server) para evitar parciales.
 */
async function getVentas(req, res, next) {
  try {
    const { articuloId, from, to } = req.query;
    const groupBy = String(req.query.groupBy || 'day').toLowerCase();

    // Mock opcional
    if (process.env.VENTAS_MOCK === '1') {
      if (!from || !to) return res.status(400).json({ error: 'Parámetros requeridos: from, to' });
      const start = toDate(from);
      const end   = toDate(to);
      if (Number.isNaN(start) || Number.isNaN(end) || start > end) {
        return res.status(400).json({ error: 'Rango de fechas inválido' });
      }
      const items = [];
      const dayMs = 24 * 60 * 60 * 1000;
      let acc = 0;
      for (let t = start.getTime(); t <= end.getTime(); t += dayMs) {
        const d = new Date(t);
        const ymd = fmtYMD(d);
        const qty = Math.floor(1 + Math.random() * 3);
        items.push({ label: ymd, qty });
        acc += qty;
      }
      return res.json({ total: acc, items });
    }

    if (!articuloId || !from || !to) {
      return res.status(400).json({ error: 'Parámetros requeridos: articuloId, from, to' });
    }

    const targetId = Number(articuloId);
    if (!Number.isFinite(targetId)) {
      return res.status(400).json({ error: 'articuloId inválido' });
    }

    const start = toDate(from);
    let end     = toDate(to);

    // 🔒 clamp a AYER
    const now = new Date();
    const todayMid = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (end >= todayMid) end = addDays(todayMid, -1);

    if (Number.isNaN(start) || Number.isNaN(end) || start > end) {
      return res.status(400).json({ error: 'Rango de fechas inválido' });
    }

    const token = await getMaxiToken();

    // iterar por semanas [cursor..stop] sin solapamiento
    let cursor = new Date(start);
    const lines = [];

    while (cursor <= end) {
      const cStart = new Date(cursor);
      const cEnd   = addDays(cursor, 6);
      const stop   = (cEnd < end ? cEnd : end);

      const content = await fetchFullByDate(fmtYMD(cStart), fmtYMD(stop), token);
      const chunk = extractDeepLeafItems(content, targetId);
      if (chunk.length) lines.push(...chunk);

      cursor = addDays(stop, 1);
    }

    // agrupar por day|week|month
    const bucket = new Map();
    for (const it of lines) {
      const d = toDate(it.fechaYMD);
      const label =
        groupBy === 'month' ? monthLabel(d) :
        groupBy === 'week'  ? weekLabel(d)  :
        fmtYMD(d); // day
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
