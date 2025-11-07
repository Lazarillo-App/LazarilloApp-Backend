// services/maxiSalesService.js
const fetch = require('node-fetch');
const { getCreds } = require('../services/maxiCredsService');
const { decryptSecretCompat } = require('../utils/cryptoField');

const MAXI_BASE = process.env.MAXI_BASE_URL || 'https://api-mconn.maxisistemas.com.ar';
const STATS_BASE = process.env.MAXI_STATS_URL || 'https://api-mconn.maxisistemas.com.ar';
const CONC = Math.max(1, Number(process.env.MAXI_FETCH_CONCURRENCY || 3));

/* ─────────── util fechas (UTC) ─────────── */
function pad2(n) { return String(n).padStart(2, '0'); }
function ymd(d) { return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`; }
function at00UTC(d) { return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); }
function addDaysUTC(d, n) { return new Date(d.getTime() + n * 86400000); }

/* ─────────── cache de bearer por negocio ─────────── */
const tokenCache = new Map(); // key -> { token, expMs }

async function loginMaxi(email, pass, codcli) {
  // intentá /auth/login; si no existe, /login
  const base = MAXI_BASE.replace(/\/+$/, '');
  const candidates = [`${base}/auth/login`, `${base}/login`];

  let lastErr;
  for (const url of candidates) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, pass, cod_cli: codcli })
      });
      const txt = await r.text().catch(() => '');
      let j; try { j = JSON.parse(txt); } catch { }
      if (!r.ok || j?.resultCode !== 'SUCCESS') {
        const err = new Error(j?.resultDescription || r.statusText || 'login Maxi falló');
        err.status = r.status || 502;
        throw err;
      }
      const token = j?.content?.tokenAccess || j?.content?.token || j?.token;
      if (!token) { const e = new Error('token Maxi vacío'); e.status = 502; throw e; }
      return token;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('login Maxi falló');
}

/**
 * getBearer(businessId, req)
 * Prioriza:
 * 1) X-Maxi-Token (sin "Bearer " adelante si ya viene)
 * 2) Cache local por business (válido ~9min)
 * 3) Credenciales de DB (props.maxi: email/codcli/pass|pass_enc)
 */
async function getBearer(businessId, req) {
  const hdrTok = req?.headers?.['x-maxi-token'];
  if (hdrTok && String(hdrTok).trim()) {
    return String(hdrTok).replace(/^Bearer\s+/i, '').trim();
  }

  const now = Date.now();
  const cached = tokenCache.get(String(businessId));
  if (cached && cached.expMs > now) return cached.token;

  const creds = await getCreds(businessId);
  const email = (creds?.email || '').trim();
  const codcli = (creds?.cod_cli || creds?.codcli || '').trim();
  const password =
    creds?.pass ??
    creds?.password ??
    (creds?.pass_enc ? decryptSecretCompat(creds.pass_enc) : null);

  if (!email || !codcli || !password) {
    const e = new Error('Faltan credenciales Maxi (email/codcli/pass) en props.maxi');
    e.status = 400;
    throw e;
  }

  const token = await loginMaxi(email, password, codcli);
  tokenCache.set(String(businessId), { token, expMs: now + 9 * 60 * 1000 });
  return token;
}

/* ─────────── low-level fetch principal: invoicebydate (GET) ─────────── */
async function fetchInvoiceByDate(fromYMD, toYMD, bearer) {
  const base = STATS_BASE.replace(/\/+$/, '');
  const url = `${base}/estadisticas/invoicebydate?from=${encodeURIComponent(fromYMD)}&to=${encodeURIComponent(toYMD)}`;

  for (let i = 0; i < 3; i++) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${bearer}` } });
    const txt = await r.text().catch(() => '');
    let j; try { j = JSON.parse(txt); } catch { }

    const ok = r.ok && (!j?.resultCode || j?.resultCode === 'SUCCESS');
    if (ok) {
      return (j?.content?.content) ? j.content.content
        : (j?.content) ? j.content
          : j ?? {};
    }

    if ([429, 502, 503].includes(r.status)) {
      if (i === 2) {
        const e = new Error(j?.resultDescription || r.statusText || 'Maxi 5xx');
        e.status = r.status || 502;
        e._maxi = { status: r.status, fromYMD, toYMD, bodyPreview: String(txt).slice(0, 200) };
        throw e;
      }
      await new Promise(res => setTimeout(res, 400 * (i + 1) ** 2));
      continue;
    }

    const e = new Error(j?.resultDescription || r.statusText || txt || 'error Maxi');
    e.status = r.status || 502;
    e._maxi = { status: r.status, fromYMD, toYMD, bodyPreview: String(txt).slice(0, 200) };
    throw e;
  }

  const e = new Error('Maxi retries exhausted');
  e.status = 502;
  throw e;
}

/* ─────────── fallback: fullinvoicebydate (GET) ─────────── */
async function tryFullInvoiceByDate(fromYMD, toYMD, bearer) {
  const base = STATS_BASE.replace(/\/+$/, '');
  const url = `${base}/estadisticas/fullinvoicebydate?from=${encodeURIComponent(fromYMD)}&to=${encodeURIComponent(toYMD)}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${bearer}` } });
  const txt = await r.text().catch(() => '');
  let j; try { j = JSON.parse(txt); } catch { }
  if (!r.ok) {
    const e = new Error(`fallback_fullinvoicebydate_${r.status}`);
    e.status = r.status || 502;
    e._maxi = { status: r.status, fromYMD, toYMD, bodyPreview: String(txt).slice(0, 200) };
    throw e;
  }
  return (j?.content?.content) ? j.content.content
    : (j?.content) ? j.content
      : j ?? {};
}

/**
 * buildWindows(fromDate, toDate, winDays)
 * Recibe Date (UTC 00:00), string "YYYY-MM-DD" o timestamp; devuelve
 * pares inclusivos [YYYY-MM-DD, YYYY-MM-DD] en ventanas de N días.
 */
function buildWindows(fromDate, toDate, winDays = 7) {
  const coerceUTC00 = (v) => {
    if (v == null) return null;
    if (v instanceof Date) return at00UTC(v);
    if (typeof v === 'string') {
      return v.length === 10 ? new Date(`${v}T00:00:00Z`) : at00UTC(new Date(v));
    }
    if (typeof v === 'number') return at00UTC(new Date(v));
    if (v && typeof v === 'object' && v.day) return coerceUTC00(v.day);
    const d = new Date(v);
    return isNaN(+d) ? null : at00UTC(d);
  };

  const A = coerceUTC00(fromDate);
  const T = coerceUTC00(toDate);
  if (!(A instanceof Date) || isNaN(+A) || !(T instanceof Date) || isNaN(+T)) {
    throw new TypeError(`buildWindows: invalid from/to (from=${String(fromDate)} to=${String(toDate)})`);
  }
  if (A > T) return [];

  const out = [];
  for (let cur = new Date(A); cur <= T;) {
    const a = new Date(cur);
    const b = addDaysUTC(a, winDays - 1);
    const stop = b < T ? b : T;
    out.push([ymd(a), ymd(stop)]);
    cur = addDaysUTC(stop, 1);
  }
  return out;
}

/* ─────────── extractor robusto ─────────── */
function extractFacturas(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.facturas)) return payload.facturas;
  if (Array.isArray(payload.content?.facturas)) return payload.content.facturas;
  if (Array.isArray(payload.content?.content?.facturas)) return payload.content.content.facturas;
  if (Array.isArray(payload.content)) return payload.content;
  for (const [, v] of Object.entries(payload)) {
    if (Array.isArray(v) && v.length && typeof v[0] === 'object') return v;
  }
  return [];
}

/* ─────────── fetch principal con fallback 7d→1d ─────────── */
async function fetchRangeWithFallback(fromDate, toDate, bearer, conc = CONC) {
  const windows7 = buildWindows(fromDate, toDate, 7);

  const results = new Array(windows7.length);
  const errors = new Array(windows7.length).fill(null);

  let idx = 0;
  async function worker() {
    while (idx < windows7.length) {
      const my = idx++;
      const [a, b] = windows7[my]; // strings YYYY-MM-DD
      try {
        results[my] = await fetchInvoiceByDate(a, b, bearer);
      } catch (e) {
        // si no existe el endpoint nuevo, probá fallback para esa ventana
        if (String(e?.message || '').includes('404') || String(e?.message || '').includes('501')) {
          try {
            results[my] = await fetchInvoiceByDate(a, b, bearer);
            errors[my] = null;
            continue;
          } catch (e2) {
            errors[my] = e2;
            continue;
          }
        }
        errors[my] = e;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(conc, windows7.length) }, worker));

  const outPayloads = [];
  for (let i = 0; i < windows7.length; i++) {
    if (!errors[i]) {
      outPayloads.push(results[i]);
      continue;
    }

    const err = errors[i];
    if ((err?.status || 0) >= 500) {
      // fallback por día (1d) sobre esa ventana
      const [wa, wb] = windows7[i];
      const a = new Date(`${wa}T00:00:00Z`);
      const b = new Date(`${wb}T00:00:00Z`);
      const days = buildWindows(a, b, 1);
      for (const [da, db] of days) {
        try {
          const dayPayload = await fetchInvoiceByDate(da, db, bearer);
          outPayloads.push(dayPayload);
        } catch (e2) {
          try {
            const dayPayload2 = await tryFullInvoiceByDate(da, db, bearer);
            outPayloads.push(dayPayload2);
            continue;
          } catch {
            console.warn('[maxi fallback] falló día', { da, db, status: e2?.status, info: e2?._maxi });
          }
        }
      }
    } else {
      // error “duro” (4xx distinto de 404/401, etc.)
      throw err;
    }
  }
  return outPayloads;
}

/**
 * fetchSalesRanged({ businessId, from, to, req })
 * Devuelve array de "facturas" crudas (ya aplanadas) listas para normalizar.
 */
async function fetchSalesRanged({ businessId, from, to, req }) {
  if (!businessId) { const e = new Error('businessId requerido'); e.status = 400; throw e; }

  // Normalizar a UTC 00:00 y clamp a AYER
  const todayUTC = at00UTC(new Date());
  const AYER = addDaysUTC(todayUTC, -1);
  const Fd = at00UTC(new Date(from));
  const Td = at00UTC(new Date(to));
  const toClamp = Td > AYER ? AYER : Td;

  const bearer = await getBearer(businessId, req);
  const payloads = await fetchRangeWithFallback(Fd, toClamp, bearer, CONC);

  const facturas = [];
  for (const p of (payloads || [])) {
    let arr = extractFacturas(p);
    if (!Array.isArray(arr) || !arr.length) continue;
    // aplanar { factura: {...} }
    if (arr[0] && typeof arr[0] === 'object' && Object.prototype.hasOwnProperty.call(arr[0], 'factura')) {
      arr = arr.map(x => x?.factura || x).filter(Boolean);
    }
    if (arr.length) facturas.push(...arr);
  }
  return facturas;
}

module.exports = {
  MAXI_BASE,
  STATS_BASE,
  getBearer,
  fetchInvoiceByDate,
  buildWindows,
  extractFacturas,
  fetchSalesRanged,
};
