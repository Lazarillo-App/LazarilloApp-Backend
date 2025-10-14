// services/maxiSalesService.js
const fetch = require('node-fetch');
const { getCreds } = require('../services/maxiCredsService');

const MAXI_BASE  = process.env.MAXI_BASE_URL  || 'https://api-mconn.maxisistemas.com.ar';
const STATS_BASE = process.env.MAXI_STATS_URL || 'https://api-mconn.maxisistemas.com.ar';
const CONC = Math.max(1, Number(process.env.MAXI_FETCH_CONCURRENCY || 3));

// ---- cache de token por negocio ----
const tokenCache = new Map(); // key -> { token, expMs }

function pad2(n){ return String(n).padStart(2,'0'); }
function ymd(d){ return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth()+1)}-${pad2(d.getUTCDate())}`; }
function at00UTC(d){ const x=new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); return x; }
function addDaysUTC(d, n){ const x=new Date(d.getTime() + n*86400000); return x; }

// ------------------ bearer ------------------
async function loginMaxi(email, pass, codcli) {
  const url = `${MAXI_BASE.replace(/\/+$/,'')}/login`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type':'application/json' },
    body: JSON.stringify({ email, pass, cod_cli: codcli })
  });
  const txt = await r.text().catch(()=>'');
  let j; try { j = JSON.parse(txt); } catch {}
  if (!r.ok || j?.resultCode !== 'SUCCESS') {
    const err = new Error(j?.resultDescription || r.statusText || 'login Maxi falló');
    err.status = r.status || 502;
    throw err;
  }
  const token = j?.content?.tokenAccess;
  if (!token) { const e=new Error('token Maxi vacío'); e.status=502; throw e; }
  return token;
}

/**
 * Obtiene Bearer en este orden:
 * 1) Header X-Maxi-Token (prioritario)
 * 2) Cache por business
 * 3) Credenciales cifradas en props.maxi -> login
 */
async function getBearer(businessId, req) {
  const hdrTok = (req?.headers?.['x-maxi-token'] || req?.headers?.['X-Maxi-Token']);
  if (hdrTok && String(hdrTok).trim()) return String(hdrTok).trim();

  const now = Date.now();
  const cached = tokenCache.get(String(businessId));
  if (cached && cached.expMs > now) return cached.token;

  const creds = await getCreds(businessId);
  if (!creds?.email || !creds?.pass || !(creds?.cod_cli || creds?.codcli)) {
    const e = new Error('Faltan credenciales Maxi (email/codcli/pass) en props.maxi');
    e.status = 400; throw e;
  }
  const codcli = creds.cod_cli || creds.codcli;
  const token = await loginMaxi(creds.email, creds.pass, codcli);
  tokenCache.set(String(businessId), { token, expMs: now + 9*60*1000 });
  return token;
}

// ------------------ fetch low-level ------------------
async function fetchFullByDate(fromYMD, toYMD, bearer) {
  const url = `${STATS_BASE.replace(/\/+$/,'')}/estadisticas/fullinvoicebydate?from=${encodeURIComponent(fromYMD)}&to=${encodeURIComponent(toYMD)}`;
  // 3 intentos con backoff; si es 500, lo propagamos para que el caller decida fallback
  for (let i=0;i<3;i++){
    const r = await fetch(url, { headers: { Authorization: `Bearer ${bearer}` } });
    const txt = await r.text().catch(()=> '');
    let j; try { j = JSON.parse(txt); } catch {}
    const ok = r.ok && (!j?.resultCode || j?.resultCode === 'SUCCESS');

    if (ok) return j?.content ?? j ?? {};

    // Errores transitorios
    if ([429,502,503].includes(r.status)) {
      // si es el último intento devolvemos error
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
  const e = new Error('Maxi retries exhausted');
  e.status = 502;
  throw e;
}

// Particiona [from,to] en ventanas de N días
function buildWindows(fromDate, toDate, winDays) {
  const out = [];
  for (let cur = new Date(fromDate); cur <= toDate; ) {
    const a = new Date(cur);
    const b = addDaysUTC(cur, winDays - 1);
    const stop = b < toDate ? b : toDate;
    out.push([ymd(a), ymd(stop)]);
    cur = addDaysUTC(stop, 1);
  }
  return out;
}

// ---- Fallback: 7d -> (si falla) 1d ----
async function fetchRangeWithFallback(fromDate, toDate, bearer, conc = CONC) {
  const windows7 = buildWindows(fromDate, toDate, 7);

  // Primero intentamos 7d en paralelo
  const results = new Array(windows7.length);
  const errors  = new Array(windows7.length).fill(null);

  let idx = 0;
  async function worker(){
    while (idx < windows7.length) {
      const my = idx++;
      const [a,b] = windows7[my];
      try {
        results[my] = await fetchFullByDate(a, b, bearer);
      } catch (e) {
        errors[my] = e;
      }
    }
  }
  await Promise.all(Array.from({length: Math.min(conc, windows7.length)}, worker));

  // Para las que fallaron con 5xx, reintentar día por día
  const outPayloads = [];
  for (let i=0;i<windows7.length;i++){
    if (!errors[i]) {
      outPayloads.push(results[i]);
      continue;
    }
    const err = errors[i];
    if ((err?.status || 0) >= 500) {
      const [wa, wb] = windows7[i];
      const a = new Date(wa+'T00:00:00Z'), b = new Date(wb+'T00:00:00Z');
      const days = buildWindows(a,b,1);
      for (const [da,db] of days) {
        try {
          const dayPayload = await fetchFullByDate(da, db, bearer);
          outPayloads.push(dayPayload);
        } catch (e2) {
          // si sigue fallando un día puntual, lo registramos y seguimos
          console.warn('[maxi fallback] falló día', { da, db, status: e2?.status, info: e2?._maxi });
        }
      }
    } else {
      // error no 5xx → lo propagamos
      throw err;
    }
  }
  return outPayloads;
}

// --------- API principal usada por el controlador ---------
/**
 * fetchSalesRanged({ businessId, from, to, req })
 * Devuelve un array "facturas" crudas (sin normalizar) listas para pasar a salesStore.
 */
async function fetchSalesRanged({ businessId, from, to, req }) {
  if (!businessId) { const e=new Error('businessId requerido'); e.status=400; throw e; }

  // Normalizamos fechas a UTC 00:00 y clamp a AYER (por política)
  const todayUTC = at00UTC(new Date());
  const AYER = addDaysUTC(todayUTC, -1);
  const Fd = at00UTC(new Date(from));
  const Td = at00UTC(new Date(to));
  const toClamp = Td > AYER ? AYER : Td;

  const bearer = await getBearer(businessId, req);
  const payloads = await fetchRangeWithFallback(Fd, toClamp, bearer, CONC);

  // Extraer facturas de cada payload defensivamente
  const facturas = [];
  for (const p of (payloads || [])) {
    const arr = p?.facturas ?? p?.content?.facturas ?? p?.content ?? [];
    if (Array.isArray(arr)) facturas.push(...arr);
  }
  return facturas;
}

module.exports = {
  MAXI_BASE,
  STATS_BASE,
  getBearer,
  fetchSalesRanged,
};
