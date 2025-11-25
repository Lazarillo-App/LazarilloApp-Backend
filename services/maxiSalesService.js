// services/maxiSalesService.js
/* eslint-disable no-console */
'use strict';

const { getCreds } = require('../services/maxiCredsService');
const { decryptSecretCompat } = require('../utils/cryptoField');

// Usa fetch nativo (Node 18+) y cae a node-fetch si hace falta
const fetchNative =
  (typeof globalThis.fetch === 'function')
    ? ((...args) => globalThis.fetch(...args))
    : require('node-fetch');

const MAXI_BASE  = (process.env.MAXI_BASE_URL  || 'https://api-mconn.maxisistemas.com.ar').replace(/\/+$/,'');
const STATS_BASE = (process.env.MAXI_STATS_URL || 'https://api-mconn.maxisistemas.com.ar').replace(/\/+$/,'');

// 🆕 path configurable: por defecto usamos fullinvoicebydate
const STATS_INVOICE_PATH = (process.env.MAXI_INVOICE_PATH || '/estadisticas/fullinvoicebydate').replace(/\/+$/,'');

const CONC = Math.max(1, Number(process.env.MAXI_FETCH_CONCURRENCY || 3));

/* ───────── fechas (UTC) ───────── */
function pad2(n){ return String(n).padStart(2,'0'); }
function ymd(d){ return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth()+1)}-${pad2(d.getUTCDate())}`; }
function at00UTC(d){ return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); }
function addDaysUTC(d, n){ return new Date(d.getTime() + n * 86400000); }

/* ───────── bearer cache ───────── */
const tokenCache = new Map();

/* ✅ LOGIN CORRECTO: sin Authorization; POST con email/pass/cod_cli */
async function loginMaxi(email, pass, codcli) {
  const url = `${MAXI_BASE}/login`;
  const r = await fetchNative(url, {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'Accept':'application/json' },
    body: JSON.stringify({ email, pass, cod_cli: String(codcli) })
  });

  const txt = await r.text().catch(()=> '');
  let j; try { j = JSON.parse(txt); } catch {}

  const ok = r.ok && j?.resultCode === 'SUCCESS' && j?.content?.tokenAccess;
  if (!ok) {
    const err = new Error(j?.resultDescription || r.statusText || 'login Maxi falló');
    err.status = r.status || 502;
    err._body = txt.slice(0, 400);
    throw err;
  }
  return j.content.tokenAccess;
}

/**
 * getBearer(businessId, req)
 * Prioriza:
 * 1) X-Maxi-Token
 * 2) Cache local (9 min)
 * 3) Creds DB (email/codcli/pass|pass_enc)
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
  const email  = (creds?.email || '').trim();
  const codcli = (creds?.cod_cli || creds?.codcli || '').trim();
  const password =
    creds?.pass ??
    creds?.password ??
    (creds?.pass_enc ? decryptSecretCompat(creds.pass_enc) : null);

  if (!email || !codcli || !password) {
    const e = new Error('Faltan credenciales Maxi (email/codcli/pass) en props.maxi');
    e.status = 400; throw e;
  }

  const token = await loginMaxi(email, password, codcli);
  tokenCache.set(String(businessId), { token, expMs: now + 9 * 60 * 1000 });
  return token;
}

/* ───────── low-level fetch (invoicebydate) ───────── */
async function fetchInvoiceByDate(fromYMD, toYMD, bearer) {
  const url = `${STATS_BASE}${STATS_INVOICE_PATH}?from=${encodeURIComponent(fromYMD)}&to=${encodeURIComponent(toYMD)}`;

  for (let i=0;i<3;i++){
    const r = await fetchNative(url, { headers: { Authorization: `Bearer ${bearer}` } });
    const txt = await r.text().catch(()=> '');
    let j; try { j = JSON.parse(txt); } catch {}
    const ok = r.ok && (!j?.resultCode || j?.resultCode === 'SUCCESS');

    if (ok) {
      return (j?.content?.content) ? j.content.content
           : (j?.content)          ? j.content
           : j ?? {};
    }

    if ([429,502,503].includes(r.status)) {
      if (i === 2) {
        const e = new Error(j?.resultDescription || r.statusText || 'Maxi 5xx');
        e.status = r.status || 502;
        e._maxi = { status: r.status, fromYMD, toYMD, bodyPreview: String(txt).slice(0,200) };
        throw e;
      }
      await new Promise(res => setTimeout(res, 400 * (i+1)**2));
      continue;
    }

    const e = new Error(j?.resultDescription || r.statusText || txt || 'error Maxi');
    e.status = r.status || 502;
    e._maxi = { status: r.status, fromYMD, toYMD, bodyPreview: String(txt).slice(0,200) };
    throw e;
  }
  const e = new Error('Maxi retries exhausted'); e.status = 502; throw e;
}

/* ───────── ventanas ───────── */
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
  for (let cur = new Date(A); cur <= T; ) {
    const a = new Date(cur);
    const b = addDaysUTC(a, winDays - 1);
    const stop = b < T ? b : T;
    out.push([ymd(a), ymd(stop)]);
    cur = addDaysUTC(stop, 1);
  }
  return out;
}

/* ───────── extractor ───────── */
function extractFacturas(payload) {
  if (!payload) return [];

  // fullinvoicebydate variantes
  const content = payload?.content ?? payload;
  const inner   = content?.content ?? content;

  // { content: { content: { facturas:[{ factura }, ...] } } }
  if (Array.isArray(inner?.facturas)) return inner.facturas.filter(Boolean);

  // { facturas:[{ factura }, ...] }
  if (Array.isArray(payload?.facturas)) return payload.facturas.filter(Boolean);

  // invoicebydate: array con órdenes
  const arr = Array.isArray(inner) ? inner : (Array.isArray(payload) ? payload : null);
  if (arr && arr.length) {
    if (arr.some(x => x?.order?.orderData || x?.orderData)) {
      return arr.map(x => {
        if (x?.order?.orderData) return x;             // { order:{...} }
        if (x?.orderData)         return { order: x };  // wrap
        return x;
      });
    }
    return arr;
  }

  if (Array.isArray(content)) return content;
  return [];
}

/* ───────── fetch 7d→1d con invoicebydate ───────── */
async function fetchRangeWithFallback(fromDate, toDate, bearer, conc = CONC) {
  const windows7 = buildWindows(fromDate, toDate, 7);

  const results = new Array(windows7.length);
  const errors  = new Array(windows7.length).fill(null);

  let idx = 0;
  async function worker(){
    while (idx < windows7.length) {
      const my = idx++;
      const [a,b] = windows7[my];
      try {
        results[my] = await fetchInvoiceByDate(a, b, bearer);
      } catch (e) {
        errors[my] = e;
      }
    }
  }
  await Promise.all(Array.from({length: Math.min(conc, windows7.length)}, worker));

  const outPayloads = [];
  for (let i=0;i<windows7.length;i++){
    if (!errors[i]) { outPayloads.push(results[i]); continue; }
    const err = errors[i];
    if ((err?.status || 0) >= 500) {
      const [wa, wb] = windows7[i];
      const a = new Date(`${wa}T00:00:00Z`);
      const b = new Date(`${wb}T00:00:00Z`);
      const days = buildWindows(a, b, 1);
      for (const [da, db] of days) {
        try {
          const dayPayload = await fetchInvoiceByDate(da, db, bearer);
          outPayloads.push(dayPayload);
        } catch (e2) {
          console.warn('[maxi fallback] falló día', { da, db, status: e2?.status, info: e2?._maxi });
        }
      }
    } else {
      throw err;
    }
  }
  return outPayloads;
}

/* ───────── API pública ───────── */
async function fetchSalesRanged({ businessId, from, to, req }) {
  if (!businessId) { const e = new Error('businessId requerido'); e.status = 400; throw e; }

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

    // fullinvoicebydate: [{ factura }, ...] → extraer factura
    if (arr[0] && typeof arr[0] === 'object' && Object.prototype.hasOwnProperty.call(arr[0], 'factura')) {
      arr = arr.map(x => x?.factura || x).filter(Boolean);
    }
    // invoicebydate: devolver órdenes tal cual
    if (arr.length) facturas.push(...arr);
  }
  return facturas;
}

module.exports = {
  MAXI_BASE,
  STATS_BASE,
  at00UTC,
  addDaysUTC,
  getBearer,
  fetchInvoiceByDate,
  buildWindows,
  extractFacturas,
  fetchSalesRanged,
};
