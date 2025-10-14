// services/maxiSalesService.js
const fetch = require('node-fetch');
const { getCreds } = require('./maxiCredsService');

const MAXI_BASE  = process.env.MAXI_BASE_URL  || 'https://api-mconn.maxisistemas.com.ar';
const STATS_BASE = process.env.MAXI_STATS_URL || 'https://api-mconn.maxisistemas.com.ar';
exports.STATS_BASE = STATS_BASE;

const tokenCache = new Map(); // businessId -> { token, exp, source }

/** Login a Maxi con credenciales (email/pass/codcli) */
async function loginMaxi({ email, pass, codcli }) {
  const r = await fetch(`${MAXI_BASE.replace(/\/+$/, '')}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, pass, cod_cli: codcli }),
  });
  const txt = await r.text().catch(() => '');
  let j; try { j = JSON.parse(txt); } catch {}
  if (!r.ok || j?.resultCode !== 'SUCCESS') {
    const e = new Error(j?.resultDescription || r.statusText || 'login Maxi falló');
    e.status = 502; throw e;
  }
  const token = j?.content?.tokenAccess;
  if (!token) { const e = new Error('token Maxi vacío'); e.status = 502; throw e; }
  return token;
}
exports.loginMaxi = loginMaxi;

/**
 * Obtiene Bearer para Maxi en este orden:
 * 1) override header: X-Maxi-Token | X-Maxi-Bearer
 * 2) cache válido (9min)
 * 3) credenciales del negocio (props.maxi -> login)
 * 4) fallback env (MAXI_EMAIL/PASS/CODCLI -> login)
 */
async function getBearer(businessId, req) {
  const now = Date.now();

  // (1) override por header (debug/urgencias)
  const hdr = (req?.headers?.['x-maxi-token'] || req?.headers?.['x-maxi-bearer'] || '').trim();
  if (hdr) {
    tokenCache.set(businessId, { token: hdr, exp: now + 8.5 * 60 * 1000, source: 'override_header' });
    return hdr;
  }

  // (2) cache
  const cached = tokenCache.get(businessId);
  if (cached && cached.exp > now) return cached.token;

  // (3) credenciales por negocio
  const creds = await getCreds(businessId); // { email, pass, codcli } | null
  let email, pass, codcli;
  if (creds) {
    ({ email, pass, codcli } = creds);
  } else {
    // (4) fallback ENV
    email  = process.env.MAXI_EMAIL  || '';
    pass   = process.env.MAXI_PASS   || '';
    codcli = process.env.MAXI_CODCLI || '';
  }
  if (!email || !pass || !codcli) {
    const e = new Error('Faltan credenciales Maxi (email/pass/codcli) en DB o ENV');
    e.status = 400; throw e;
  }

  const token = await loginMaxi({ email, pass, codcli });
  tokenCache.set(businessId, { token, exp: now + 8.5 * 60 * 1000, source: creds ? 'db_login' : 'env_login' });
  return token;
}
exports.getBearer = getBearer;

/** util fechas */
const pad2 = n => String(n).padStart(2, '0');
const ymd  = d => `${d.getUTCFullYear()}-${pad2(d.getUTCMonth()+1)}-${pad2(d.getUTCDate())}`;
const addDays = (d, n) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + n));

/** Fetch 7d con retry simple */
async function fetchFullByDate(fromYMD, toYMD, bearer) {
  const url = `${STATS_BASE.replace(/\/+$/, '')}/estadisticas/fullinvoicebydate?from=${encodeURIComponent(fromYMD)}&to=${encodeURIComponent(toYMD)}`;
  for (let i = 0; i < 3; i++) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${bearer}` } });
    const txt = await r.text().catch(() => ''); let j; try { j = JSON.parse(txt); } catch {}
    if (r.ok && (!j?.resultCode || j?.resultCode === 'SUCCESS')) {
      return j?.content ?? j ?? {};
    }
    if ([429,502,503].includes(r.status)) { await new Promise(res => setTimeout(res, 500 * (i+1)**2)); continue; }
    const e = new Error(j?.resultDescription || r.statusText || 'error Maxi');
    e.status = r.status || 502; throw e;
  }
  const e = new Error('Maxi retries exhausted'); e.status = 502; throw e;
}

/**
 * Descarga en ventanas de 7 días [from..to] ambas inclusive.
 * Requiere businessId y usa getBearer(businessId, req).
 */
async function fetchSalesRanged({ businessId, from, to, req, conc = Math.max(1, Number(process.env.MAXI_FETCH_CONCURRENCY || 3)) }) {
  if (!businessId) throw new Error('businessId requerido');
  if (!(from instanceof Date) || !(to instanceof Date)) throw new Error('from/to inválidos');

  const bearer = await getBearer(businessId, req);

  // Particionar en ventanas de 7d
  const start = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const end   = new Date(Date.UTC(to.getUTCFullYear(),   to.getUTCMonth(),   to.getUTCDate()));
  const windows = [];
  for (let cur = new Date(start); cur <= end; ) {
    const a = new Date(cur);
    const b = addDays(cur, 6);
    const stop = b < end ? b : end;
    windows.push([ymd(a), ymd(stop)]);
    cur = addDays(stop, 1);
  }

  const results = new Array(windows.length);
  let idx = 0;
  async function worker() {
    while (idx < windows.length) {
      const my = idx++;
      const [a,b] = windows[my];
      results[my] = await fetchFullByDate(a, b, bearer);
    }
  }
  await Promise.all(Array.from({ length: Math.min(conc, windows.length) }, worker));

  // Normalizá a array de comprobantes crudos (lo procesa salesStore)
  return results.flatMap(x => x?.facturas || []);
}
exports.fetchSalesRanged = fetchSalesRanged;
