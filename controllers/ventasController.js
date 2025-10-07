// backend/src/controllers/ventasController.js
// — Blindado + multi-tenant (token por negocio) + búsqueda por código/nombre + peek —

const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const { getCreds } = require('../services/maxiCredsService');

// ====================== ENV & CONST ======================
const MAXI_BASE =
  process.env.MAXI_BASE ||
  process.env.MAXI_BASE_URL ||
  'https://api-mconn.maxisistemas.com.ar';

const LOGIN_URL = `${MAXI_BASE}/login`;
const STATS_URLS = [
  `${MAXI_BASE}/estadisticas/invoicebydate`,     // el que muestra el portal
  `${MAXI_BASE}/estadisticas/fullinvoicebydate`, // fallback por si tu server usa éste
];


const LOG_MAXI_RAW = process.env.LOG_MAXI_RAW === '1';
const LOG_PARSER_DEBUG = process.env.LOG_PARSER_DEBUG === '1';
const AR_TIMEZONE = process.env.AR_TIMEZONE || 'America/Argentina/Buenos_Aires';
const USE_MOCK = process.env.VENTAS_MOCK === '1';

const MAXI_MAX_WINDOW_DAYS = Number(process.env.MAXI_MAX_WINDOW_DAYS || 6);
const MAXI_CONCURRENCY = Number(process.env.MAXI_CONCURRENCY || 2);
const MAXI_RETRIES = Number(process.env.MAXI_RETRIES || 4);
const MAXI_RETRY_BASE_MS = Number(process.env.MAXI_RETRY_BASE_MS || 600);
const MAXI_FETCH_TIMEOUT_MS = Number(process.env.MAXI_FETCH_TIMEOUT_MS || 20000);
const MAXI_FETCH_TIMEOUT_CAP_MS = Number(process.env.MAXI_FETCH_TIMEOUT_CAP_MS || 90000);

const logRaw = (...a) => { if (LOG_MAXI_RAW) console.log('[MAXI]', ...a); };
const dbg = (...a) => { if (LOG_PARSER_DEBUG) console.log('[PARSER]', ...a); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ====================== LOGIN (cache por negocio) ======================
const TOKEN_CACHE = new Map(); // key -> { token, expAt }
const LOGIN_INFLIGHT = new Map(); // key -> Promise

const cacheKey = (creds, req) =>
  `${req?.business?.id || 'env'}:${creds.email}:${creds.cod_cli}`;

async function readCredsFromDBOrEnv(req) {
  // 1) DB por negocio activo
  if (req?.business?.id) {
    try {
      const c = await getCreds(req.business.id);
      if (c?.email && c?.pass && c?.cod_cli) return c;
    } catch (e) {
      console.warn('[ventas] getCreds falló:', e?.message);
    }
  }
  // 2) Fallback .env (testing)
  const email = process.env.MAXI_EMAIL || process.env.EMAIL || '';
  const pass = process.env.MAXI_PASS || process.env.PASS || '';
  const cod_cli = process.env.MAXI_CODCLI || process.env.CODCLI || process.env.MAXI_CLIENTE || '';
  return { email: String(email).trim(), pass: String(pass).trim(), cod_cli: String(cod_cli).trim() };
}

function pickTokenAndTTL(json) {
  const c = json?.content ?? json;
  const token = c?.access_token || c?.tokenAccess || c?.token || c?.accessToken || null;
  const ttl = Number(c?.expires_in ?? c?.aliveTime ?? 3600);
  return { token, ttl };
}

async function loginMaxiInner(req, creds, key) {
  const variants = [
    { label: 'email/pass/cod_cli', body: { email: creds.email, pass: creds.pass, cod_cli: creds.cod_cli } },
    { label: 'usuario/password/cliente', body: { usuario: creds.email, password: creds.pass, cliente: creds.cod_cli } },
  ];
  let lastTxt = '';
  for (const v of variants) {
    logRaw('POST /login ->', v.label);
    const res = await fetch(LOGIN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(v.body)
    });
    const txt = await res.text(); lastTxt = txt;
    let json; try { json = JSON.parse(txt); } catch { json = null; }
    logRaw('RESP /login', res.status, txt.slice(0, 500));
    if (res.ok && json) {
      const { token, ttl } = pickTokenAndTTL(json);
      if (token) {
        TOKEN_CACHE.set(key, { token, expAt: Date.now() + (Number(ttl) || 3600) * 1000 });
        return token;
      }
      if (res.status === 200) continue;
    }
    if (res.status === 422) continue;
    throw new Error(`Login Maxi falló: ${res.status} ${txt}`);
  }
  throw new Error(`Login Maxi falló: 200/422 ${lastTxt}`);
}

async function loginMaxi(req, creds, key) {
  if (LOGIN_INFLIGHT.has(key)) return await LOGIN_INFLIGHT.get(key);
  const p = (async () => {
    try { return await loginMaxiInner(req, creds, key); }
    finally { LOGIN_INFLIGHT.delete(key); }
  })();
  LOGIN_INFLIGHT.set(key, p);
  return await p;
}

async function getToken(req, { force = false } = {}) {
  const creds = await readCredsFromDBOrEnv(req);
  const key = cacheKey(creds, req);
  const cached = TOKEN_CACHE.get(key);
  const stillValid = cached && Date.now() < (cached.expAt - 30_000);
  if (!force && stillValid) return cached.token;
  await loginMaxi(req, creds, key);
  return TOKEN_CACHE.get(key).token;
}

// ====================== FECHAS ======================
const isYMD = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
function ymdInTZ(date, tz) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(date).reduce((a, p) => (a[p.type] = p.value, a), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function normalizeInputYMD(v, tz) {
  if (isYMD(v)) return v;
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d)) return null;
  return ymdInTZ(d, tz);
}
function getAyer(tz = AR_TIMEZONE) {
  const now = new Date();
  return ymdInTZ(new Date(now.getTime() - 86400000), tz);
}
function clampToAyer({ from, to, tz = AR_TIMEZONE }) {
  const AYER = getAyer(tz);
  let F = from ? normalizeInputYMD(from, tz) : AYER;
  let T = to ? normalizeInputYMD(to, tz) : AYER;
  if (!F) F = AYER; if (!T) T = AYER;
  if (T > AYER) T = AYER; if (F > T) F = T;
  return { from: F, to: T, AYER };
}
function dateRangeDays(F, T) {
  const [fy, fm, fd] = F.split('-').map(Number);
  const [ty, tm, td] = T.split('-').map(Number);
  const s = Date.UTC(fy, fm - 1, fd);
  const e = Date.UTC(ty, tm - 1, td);
  const out = [];
  for (let t = s; t <= e; t += 86400000) {
    const d = new Date(t);
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`);
  }
  return out;
}
function diffDays(F, T) {
  const [fy, fm, fd] = F.split('-').map(Number);
  const [ty, tm, td] = T.split('-').map(Number);
  return Math.floor((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86400000);
}
function ymdAddDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d) + n * 86400000;
  const dt = new Date(t);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

// ====================== FETCH con retries ======================
const isAbort = (e) => e?.name === 'AbortError' || e?.type === 'aborted' || /aborted/i.test(String(e?.message || ''));
const isTransient = (e) =>
  isAbort(e) ||
  [429, 500, 502, 503, 504].includes(e?.status) ||
  /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.test(e?.code || '') ||
  /timeout/i.test(String(e?.message || ''));

async function fetchStatsWithRetry({ from, to, req }) {
  const tryOnce = async (timeoutMs) => {
    const token = await getToken(req);
    const bearer = String(token).startsWith('Bearer ') ? token : `Bearer ${token}`;

    // probamos primero invoicebydate, luego fullinvoicebydate
    let lastErr;
    for (const baseUrl of STATS_URLS) {
      const url = `${baseUrl}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
      logRaw('GET', url);

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
      try {
        const res = await fetch(url, { headers: { Authorization: bearer }, signal: ctrl.signal });
        const txt = await res.text();
        let json; try { json = JSON.parse(txt); } catch { json = null; }

        logRaw(`[MAXI] ${res.status} ${url} ::`, txt.slice(0, 500));

        if (!res.ok) {
          const apiCode = json?.resultCode ?? json?.content?.resultCode ?? json?.result?.resultCode ?? null;
          const err = new Error(`HTTP ${res.status} ${txt || ''}`);
          err.status = res.status; err.apiCode = apiCode;
          lastErr = err;
          continue; // probá el siguiente endpoint
        }

        // si ok, devolveme el JSON parseado
        return json ?? {};
      } catch (e) {
        lastErr = e;
      } finally {
        clearTimeout(timer);
      }
    }
    // si ninguno funcionó, tiro el último error
    throw lastErr || new Error('No Maxi endpoint succeeded');
  };

  for (let attempt = 1; attempt <= MAXI_RETRIES; attempt++) {
    const timeoutMs = Math.min(MAXI_FETCH_TIMEOUT_MS * Math.pow(2, attempt - 1), MAXI_FETCH_TIMEOUT_CAP_MS);
    try {
      return await tryOnce(timeoutMs);
    } catch (e) {
      if (e?.status === 401 || e?.status === 403) { await getToken(req, { force: true }); attempt--; continue; }
      if (isTransient(e) && attempt < MAXI_RETRIES) {
        const wait = Math.floor(MAXI_RETRY_BASE_MS * Math.pow(2, attempt - 1) * (1 + Math.random() * 0.25));
        logRaw(`Retry ${attempt}/${MAXI_RETRIES} en ${wait}ms por ${e.status || e.code || e.name || e.message}`);
        await sleep(wait); continue;
      }
      throw e;
    }
  }
}

function segmentWindows(F, T, size) {
  const total = diffDays(F, T) + 1;
  const wins = [];
  let start = F, remain = total;
  while (remain > 0) {
    const span = Math.min(size, remain);
    const end = ymdAddDays(start, span - 1);
    wins.push([start, end]);
    start = ymdAddDays(end, 1);
    remain -= span;
  }
  return wins;
}
async function fetchSafe(a, b, req) {
  try {
    const json = await fetchStatsWithRetry({ from: a, to: b, req });
    return extractFacturas(json);
  } catch (e) {
    if (e?.status === 400 && (e.apiCode === 'LONG_PARAMS' || String(e.message).includes('LONG_PARAMS'))) {
      const span = diffDays(a, b) + 1;
      if (span <= 1) throw e;
      const mid = ymdAddDays(a, Math.floor(span / 2) - 1);
      const right = ymdAddDays(mid, 1);
      const L = await fetchSafe(a, mid, req);
      const R = await fetchSafe(right, b, req);
      return [...L, ...R];
    }
    throw e;
  }
}

async function fetchStatsAll({ from, to, req, maxDays }) {
  const size = maxDays || MAXI_MAX_WINDOW_DAYS;
  const wins = segmentWindows(from, to, size);

  const conc = Math.max(1, MAXI_CONCURRENCY);
  let cursor = 0;
  const collected = [];

  async function worker(id) {
    while (true) {
      // tomar y avanzar cursor de forma atómica
      const idx = cursor++;
      if (idx >= wins.length) break;

      const [a, b] = wins[idx];
      logRaw(`WORKER#${id} ventana ${idx + 1}/${wins.length}: ${a}..${b}`);
      const facts = await fetchSafe(a, b, req);
      collected.push(...facts);
    }
  }

  await Promise.all(Array.from({ length: conc }, (_, i) => worker(i + 1)));
  return collected;
}

// ====================== PARSER (ID, CÓDIGO y búsqueda por nombre) ======================
function extractFacturas(json) {
  // Maxi a veces responde en distintos envoltorios:
  // { content: { content: { facturas: [...] } } }
  // { content: { facturas: [...] } }
  // { content: [...] } o directamente { facturas: [...] }
  const c1 = json?.content;
  const c2 = (c1 && (c1.content ?? c1)) || json;

  // si ya viene como array de facturas
  if (Array.isArray(c2?.facturas)) return c2.facturas;
  if (Array.isArray(c2)) return c2;

  // a veces es una lista de facturas en 'content'
  if (Array.isArray(c1)) return c1;

  return [];
}

const normCode = (s) => String(s ?? '').trim().replace(/^0+/, '');

function asNum(x) {
  if (typeof x === 'number') return Number.isFinite(x) ? x : NaN;
  if (typeof x === 'string') {
    const s = x.trim();
    if (!s) return NaN;
    // Soporte robusto: "1.234,56" -> 1234.56 ; "1234.56" -> 1234.56
    if (s.includes(',') && /\d+\.\d{3}/.test(s)) {
      const n = Number(s.replace(/\./g, '').replace(',', '.'));
      return Number.isFinite(n) ? n : NaN;
    }
    if (s.includes(',')) {
      const n = Number(s.replace(',', '.'));
      return Number.isFinite(n) ? n : NaN;
    }
    const n = Number(s);
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

function pickItemId(it) {
  const cand = [
    it?.idArticulo, it?.id_articulo, it?.articuloId, it?.id, it?.IdArticulo,
    it?.idarticulo, it?.IDARTICULO,
    it?.articulo?.idArticulo, it?.articulo?.id, it?.Articulo?.id, it?.Articulo?.Id
  ].filter(v => v !== undefined && v !== null);
  for (const v of cand) {
    const n = asNum(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}
function pickItemCode(it) {
  const cand = [
    it?.codigo, it?.codArticulo, it?.codigoArticulo, it?.cod_articulo,
    it?.Codigo, it?.CODIGO,
    it?.articulo?.codigo, it?.Articulo?.codigo, it?.Articulo?.Codigo
  ].filter(v => v != null && String(v).trim() !== '');
  for (const v of cand) {
    const c = normCode(v);
    if (c) return c;
  }
  if (typeof it?.id === 'string') return normCode(it.id);
  return null;
}
function pickItemName(it) {
  const cand = [it?.descripcion, it?.nombre, it?.detalle, it?.Articulo?.descripcion, it?.articulo?.descripcion, it?.articulo?.nombre];
  const v = cand.find(x => typeof x === 'string' && x.trim());
  return v ? v.trim() : null;
}
function pickQty(it) {
  const cand = [it?.cantidad, it?.cant, it?.qty, it?.Cantidad, it?.unidades];
  for (const v of cand) { const n = asNum(v); if (Number.isFinite(n)) return n; }
  return 0;
}
function pickUnitPrice(it) {
  const cand = [it?.precio, it?.precioUnitario, it?.price, it?.importeUnitario];
  for (const v of cand) { const n = asNum(v); if (Number.isFinite(n)) return n; }
  return 0;
}
function pickAmount(it) {
  const cand = [it?.importe, it?.importeTotal, it?.totalItem, it?.total, it?.Importe, it?.subtotal];
  for (const v of cand) { const n = asNum(v); if (Number.isFinite(n)) return n; }
  return pickQty(it) * pickUnitPrice(it);
}
function getDetalleArray(f) {
  const d1 = f?.factura?.detalle, d2 = f?.detalle, d3 = f?.factura?.items, d4 = f?.items;
  const unwrap = (d) => Array.isArray(d)
    ? d
    : Array.isArray(d?.detalle) ? d.detalle
      : Array.isArray(d?.items) ? d.items
        : null;
  return unwrap(d1) || unwrap(d2) || unwrap(d3) || unwrap(d4) || [];
}
function pickDateFromFactura(f, tz = AR_TIMEZONE) {
  const src = f?.factura?.cabecera?.fecha ?? f?.factura?.fecha ?? f?.fecha ?? null;
  return src ? ymdInTZ(new Date(src), tz) : null;
}
const normText = (s) => String(s ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
const includesCI = (text, q) => normText(text).includes(normText(q));

function pickFacturaSign(f) {
  // Intenta por tipo: NC / NOTA DE CREDITO
  const tipo = String(
    f?.factura?.cabecera?.tipo ??
    f?.factura?.tipo ??
    f?.tipo ?? ''
  ).toUpperCase();
  if (/NC|NOTA\s*DE\s*CREDITO/.test(tipo)) return -1;
  // Fallback por total negativo
  const tot = asNum(
    f?.factura?.cabecera?.total ??
    f?.factura?.total ??
    f?.total
  );
  if (Number.isFinite(tot) && tot < 0) return -1;
  return 1;
}

function buildByDayForArticulo(facturas, { targetId, targetCode, q }, tz = AR_TIMEZONE) {
  const byDay = new Map();
  let cFact = 0, cDet = 0, cItems = 0, cMatch = 0;
  const sampleKeys = new Set();

  for (const f of facturas) {
    cFact++;
    const dateKey = pickDateFromFactura(f, tz);
    if (!dateKey) continue;

    const sign = pickFacturaSign(f);
    const detalle = getDetalleArray(f);
    if (!Array.isArray(detalle) || detalle.length === 0) continue;
    cDet++;

    for (const it of detalle) {
      cItems++;
      if (LOG_PARSER_DEBUG) Object.keys(it || {}).slice(0, 16).forEach(k => sampleKeys.add(k));
      const id = pickItemId(it);
      const code = pickItemCode(it);
      const name = pickItemName(it) || '';

      const okId = (targetId != null) && (typeof id === 'number') && id === targetId;
      const okCode = (targetCode != null) && (typeof code === 'string') && normCode(code) === targetCode;
      const okQ = (q != null && q !== '') && includesCI(name, q);
      if (!okId && !okCode && !okQ) continue;

      cMatch++;
      const qty = pickQty(it);
      const amt = pickAmount(it);

      const qtySigned = sign < 0 ? (qty > 0 ? -qty : qty) : qty;
      const amtSigned = sign < 0 ? (amt > 0 ? -amt : amt) : amt;

      const prev = byDay.get(dateKey) || { qty: 0, amount: 0 };
      prev.qty += qtySigned;
      prev.amount += amtSigned;
      byDay.set(dateKey, prev);
    }
  }

  const sorted = [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, v]) => ({ date, qty: v.qty, amount: v.amount }));

  const totals = sorted.reduce(
    (a, d) => ({ totalQty: a.totalQty + d.qty, totalAmount: a.totalAmount + d.amount }),
    { totalQty: 0, totalAmount: 0 }
  );

  if (LOG_PARSER_DEBUG) {
    dbg(`facturas=${cFact} conDetalle=${cDet} items=${cItems} matches=${cMatch}`);
    dbg('muestra keys items:', Array.from(sampleKeys).slice(0, 25));
  }
  return { byDay: sorted, ...totals };
}

function buildBasicMatches(facturas, { targetId, targetCode, q }, tz = AR_TIMEZONE, limit = 200) {
  const out = [];
  for (const f of facturas) {
    const dateKey = pickDateFromFactura(f, tz); if (!dateKey) continue;
    const detalle = getDetalleArray(f);
    for (const it of detalle) {
      const id = pickItemId(it);
      const code = pickItemCode(it);
      const name = pickItemName(it) || '';
      const okId = (targetId != null) && (typeof id === 'number') && id === targetId;
      const okCode = (targetCode != null) && (typeof code === 'string') && normCode(code) === targetCode;
      const okQ = (q != null && q !== '') && includesCI(name, q);
      if (!okId && !okCode && !okQ) continue;
      out.push({ date: dateKey, code: code ?? null, name, unitPrice: pickUnitPrice(it), qty: pickQty(it), amount: pickAmount(it), id: id ?? null });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

function collectDistinctItems(facturas, tz = AR_TIMEZONE, limit = 200) {
  const map = new Map();
  for (const f of facturas) {
    const dateKey = pickDateFromFactura(f, tz); if (!dateKey) continue;
    const detalle = getDetalleArray(f);
    for (const it of detalle) {
      const id = pickItemId(it), code = pickItemCode(it);
      const key = code ?? (id != null ? `#${id}` : null);
      if (!key) continue;
      const name = pickItemName(it);
      const unit = pickUnitPrice(it);
      const slot = map.get(key) || { code: code ?? null, id: (typeof id === 'number' ? id : null), name, unitPrice: unit, count: 0, sampleDate: dateKey };
      slot.count += 1;
      slot.name = slot.name || name;
      slot.unitPrice = Number.isFinite(slot.unitPrice) ? slot.unitPrice : unit;
      map.set(key, slot);
      if (map.size >= limit) break;
    }
    if (map.size >= limit) break;
  }
  return [...map.values()];
}

// ====================== MOCK ======================
function buildMock({ from, to, ignoreZero }) {
  const days = dateRangeDays(from, to);
  const data = days.map((date, i) => ({ date, qty: (i % 3 === 0) ? 2 : 0, amount: (i % 3 === 0) ? 1990 : 0 }));
  const filtered = ignoreZero ? data.filter(d => d.qty && d.amount) : data;
  const totals = filtered.reduce(
    (a, d) => ({ qty: a.qty + d.qty, amount: a.amount + d.amount }),
    { qty: 0, amount: 0 }
  );
  return { totals, data: ignoreZero ? filtered : data };
}

// ====================== HANDLERS ======================
exports.ping = (_req, res) => res.json({ ok: true });

/**
 * GET /api/ventas
 * query:
 *   - articuloId? | codigo?/articuloCode?/code? | q?
 *   - from?, to? (YYYY-MM-DD; clamp a AYER)
 *   - groupBy=day | basic=true | peek=true
 *   - ignoreZero=true|false
 *   - limit? (para basic/peek)
 *   - probe=true (diagnóstico directo a proveedor)
 */exports.getVentas = async (req, res) => {
  try {
    let { articuloId, codigo, articuloCode, code, q, from, to,
          groupBy = 'day', ignoreZero, basic, peek, limit, probe } = req.query;

    const isProbe = String(probe) === 'true';
    const hasId   = articuloId !== undefined && articuloId !== '';
    const codeRaw = codigo ?? articuloCode ?? code;
    const hasCode = codeRaw !== undefined && String(codeRaw).trim() !== '';
    const hasQ    = q !== undefined && String(q).trim() !== '';
    const LIM     = Math.min(Number(limit || 200), 1000);

    if (!hasId && !hasCode && !hasQ && String(peek) !== 'true' && !isProbe) {
      return res.status(400).json({ error: 'Enviá articuloId o codigo o q (texto). También podés usar peek=true.' });
    }
    if (groupBy !== 'day' && String(basic) !== 'true' && String(peek) !== 'true') {
      return res.status(400).json({ error: 'Sólo groupBy=day soportado (salvo basic/peek).' });
    }

    const { from: F, to: T, AYER } = clampToAyer({ from, to });

    // ---- PROBE: golpea directamente los dos endpoints del proveedor ----
    if (isProbe) {
      const token  = await getToken(req);
      const bearer = String(token).startsWith('Bearer ') ? token : `Bearer ${token}`;
      const base   = MAXI_BASE.replace(/\/+$/, '');

      const hit = async (url) => {
        const r   = await fetch(url, { headers: { Authorization: bearer } });
        const txt = await r.text();
        let json; try { json = JSON.parse(txt); } catch {}
        logRaw('[PROBE]', r.status, url, txt.slice(0, 600));

        const body = json ?? {};
        const facts =
          Array.isArray(body?.content?.content?.facturas) ? body.content.content.facturas :
          Array.isArray(body?.content?.facturas)          ? body.content.facturas :
          Array.isArray(body?.facturas)                   ? body.facturas : [];
        return { status: r.status, count: facts.length, sample: facts[0] ?? null };
      };

      const u1 = `${base}/estadisticas/invoicebydate?from=${encodeURIComponent(F)}&to=${encodeURIComponent(T)}`; // cabeceras
      const u2 = `${base}/estadisticas/fullinvoicebydate?from=${encodeURIComponent(F)}&to=${encodeURIComponent(T)}`; // detalle (máx 7d)
      const head = await hit(u1);
      const full = await hit(u2);
      return res.json({ rango: { from: F, to: T, clampTo: AYER }, probe: { invoicebydate: head, fullinvoicebydate: full } });
    }

    // ---- FLUJO REAL ----
    const facturas = await fetchStatsAll({ from: F, to: T, req });

    const target = {
      targetId: hasId ? Number(articuloId) : null,
      targetCode: hasCode ? normCode(codeRaw) : null,
      q: hasQ ? String(q) : null,
    };

    if (String(peek) === 'true') {
      const items = collectDistinctItems(facturas, AR_TIMEZONE, LIM);
      return res.json({ rango: { from: F, to: T, clampTo: AYER }, filtro: target, count: items.length, peek: items });
    }

    if (String(basic) === 'true') {
      const items = buildBasicMatches(facturas, target, AR_TIMEZONE, LIM);
      return res.json({ rango: { from: F, to: T, clampTo: AYER }, filtro: target, count: items.length, basic: items });
    }

    const agg    = buildByDayForArticulo(facturas, target, AR_TIMEZONE);
    const days   = dateRangeDays(F, T);
    const filled = days.map(d => agg.byDay.find(x => x.date === d) || { date: d, qty: 0, amount: 0 });
    const data   = String(ignoreZero) === 'true' ? filled.filter(d => d.qty && d.amount) : filled;

    return res.json({
      rango: { from: F, to: T, clampTo: AYER },
      articuloId: target.targetId, codigo: target.targetCode,
      groupBy: 'day', ignoreZero: String(ignoreZero) === 'true',
      totals: { qty: agg.totalQty, amount: agg.totalAmount },
      data
    });
  } catch (e) {
    console.error('getVentas error:', e);
    res.status(500).json({ error: e.message || 'Error interno' });
  }
};

// === DIAGNÓSTICO (devuelve contadores y una muestra cruda) ===
function probeFromFacturas(facturas, tz = AR_TIMEZONE, limit = 5) {
  const sample = [];
  let facturasConDetalle = 0, itemsTotal = 0;

  for (const f of facturas) {
    const detalle = getDetalleArray(f);
    if (!Array.isArray(detalle) || detalle.length === 0) continue;
    facturasConDetalle++;
    for (const it of detalle) {
      itemsTotal++;
      if (sample.length < limit) {
        sample.push({
          // lo que vea el parser:
          pickedId: pickItemId(it),
          pickedCode: pickItemCode(it),
          pickedName: pickItemName(it),
          pickedQty: pickQty(it),
          pickedUnit: pickUnitPrice(it),
          pickedAmount: pickAmount(it),
          // y además una foto del item crudo (acotado)
          rawKeys: Object.keys(it || {}).slice(0, 25),
          rawPeek: JSON.stringify(it).slice(0, 350)
        });
      }
    }
    if (sample.length >= limit) break;
  }

  return {
    resumen: {
      facturas: facturas.length,
      facturasConDetalle,
      itemsTotal,
    },
    sample
  };
}
