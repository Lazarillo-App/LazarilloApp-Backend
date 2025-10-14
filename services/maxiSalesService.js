// services/maxiSalesService.js
const fetch = global.fetch || ((...a) => import('node-fetch').then(({ default: f }) => f(...a)));
const { getCreds } = require('./maxiCredsService');

const MAXI_BASE  = process.env.MAXI_BASE_URL  || 'https://api-mconn.maxisistemas.com.ar';
const STATS_BASE = process.env.MAXI_STATS_URL || MAXI_BASE;

// cache bearer por negocio (~9min)
const tokenCache = new Map(); // key -> { token, exp }

async function loginMaxi({ email, pass, codcli }) {
  const res = await fetch(`${MAXI_BASE.replace(/\/+$/, '')}/login`, {
    method: 'POST',
    headers: { 'Content-Type':'application/json' },
    body: JSON.stringify({ email, pass, cod_cli: codcli }),
  });
  const txt = await res.text().catch(()=>''); let json; try { json = JSON.parse(txt); } catch {}
  if (!res.ok || json?.resultCode !== 'SUCCESS') {
    const e = new Error(json?.resultDescription || res.statusText || 'login Maxi falló');
    e.status = 502; throw e;
  }
  const token = json?.content?.tokenAccess;
  if (!token) { const e = new Error('token Maxi vacío'); e.status = 502; throw e; }
  return token;
}

async function getBearer(businessId) {
  const cached = tokenCache.get(businessId);
  const now = Date.now();
  if (cached && cached.exp > now) return cached.token;

  const creds = await getCreds(businessId);
  if (!creds) {
    const e = new Error('Faltan credenciales Maxi (email/codcli/pass) en props.maxi');
    e.status = 400; throw e;
  }
  const token = await loginMaxi({ email: creds.email, pass: creds.pass, codcli: creds.codcli || creds.cod_cli });
  tokenCache.set(businessId, { token, exp: now + 9*60*1000 });
  return token;
}

function fmtDate(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth()+1).padStart(2,'0');
  const day = String(d.getUTCDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}

async function fetchWindow({ bearer, from, to }) {
  // Tu endpoint legado: /estadisticas/fullinvoicebydate?from&to
  const qs = new URLSearchParams({ from: fmtDate(from), to: fmtDate(to) }).toString();
  const url = `${STATS_BASE.replace(/\/+$/, '')}/estadisticas/fullinvoicebydate?${qs}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${bearer}` } });
  const txt = await r.text().catch(()=> ''); let j; try { j = JSON.parse(txt); } catch {}
  if (r.ok && (!j?.resultCode || j?.resultCode === 'SUCCESS')) {
    return j?.content ?? j ?? {};
  }
  const e = new Error(j?.resultDescription || r.statusText || txt || 'error Maxi');
  e.status = r.status || 502; throw e;
}

function extractComprobantes(payload) {
  const out = [];
  const facturas = payload?.facturas ?? payload?.content?.facturas ?? [];
  if (Array.isArray(facturas)) {
    for (const f of facturas) {
      const cab = f?.factura?.cabecera || {};
      const fecha = cab.fecha || f?.fecha || f?.factura?.fecha;
      const id = f?.factura?.id || f?.id || cab?.numero || cab?.comprobante || `${fecha}-${Math.random()}`;
      const total = Number(cab?.total ?? cab?.importe ?? f?.total ?? 0);
      const items = (f?.factura?.items || f?.items || []).map((it, j) => ({
        line_pos: j+1,
        sku: it?.codigo || it?.cod_art || null,
        name: it?.nombre || null,
        quantity: Number(it?.cantidad ?? it?.unidades ?? 0),
        unit_price: Number(it?.precioUnitario ?? 0),
        total: Number(it?.total ?? 0),
      }));
      out.push({ external_id: String(id), occurred_at: fecha, total, items, props: f });
    }
  }
  return out;
}

/**
 * Descarga ventas de [from, to] en ventanas de 7 días y concatena.
 */
async function fetchSalesRanged({ businessId, from, to }) {
  const bearer = await getBearer(businessId);
  const dayMs = 86400000;
  let a = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()));

  const all = [];
  while (a <= end) {
    const b = new Date(Math.min(a.getTime() + (7-1)*dayMs, end.getTime()));
    const payload = await fetchWindow({ bearer, from: a, to: b });
    all.push(...extractComprobantes(payload));
    a = new Date(b.getTime() + dayMs);
  }
  return all;
}

module.exports = { fetchSalesRanged };

