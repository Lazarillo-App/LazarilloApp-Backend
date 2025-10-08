// controllers/ventasController.js
const fetch = require('node-fetch');

// --- Config ---
const MAXI_BASE  = process.env.MAXI_BASE_URL  || 'https://api-mconn.maxisistemas.com.ar';
const STATS_BASE = process.env.MAXI_STATS_URL || 'https://api-mconn.maxisistemas.com.ar';

// Cache de tokens por negocio
const tokenCache = new Map(); // key -> { token, exp }

// ---------- utils fecha ----------
const pad2 = n => String(n).padStart(2, '0');
const ymd  = d => `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
const at00 = d => { const x = new Date(d); x.setHours(0,0,0,0); return x; };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate()+n); return x; };

function resolveMacro(s) {
  if (!s) return s;
  const today = at00(new Date());
  const ayer  = addDays(today, -1);
  const m = String(s).trim();
  if (m === '<ayer>') return ymd(ayer);
  const m2 = m.match(/^<ayer-(\d+)d>$/i);
  if (m2) return ymd(addDays(ayer, -Number(m2[1] || 0)));
  return m;
}

function clampToAyer({ from, to }) {
  const today = at00(new Date());
  const AYERd = addDays(today, -1);
  const Fd = resolveMacro(from) ? at00(new Date(resolveMacro(from))) : addDays(AYERd, -29);
  const Td = resolveMacro(to)   ? at00(new Date(resolveMacro(to)))   : AYERd;
  const T  = Td > AYERd ? AYERd : Td;
  return { from: ymd(Fd), to: ymd(T), AYER: ymd(AYERd) };
}

// ---------- credenciales/login Maxi ----------
function getBizCreds(req) {
  const maxi = req.business?.props?.maxi || {};
  return {
    email:  maxi.email  || process.env.MAXI_EMAIL,
    pass:   maxi.pass   || process.env.MAXI_PASS,
    codcli: maxi.codcli || process.env.MAXI_CODCLI,
    key:    req.businessId ? `biz:${req.businessId}` : 'env',
  };
}

async function maxiLogin(creds) {
  const now = Date.now();
  const cached = tokenCache.get(creds.key);
  if (cached && cached.exp > now) return cached.token;

  const r = await fetch(`${MAXI_BASE.replace(/\/+$/, '')}/login`, {
    method: 'POST',
    headers: { 'Content-Type':'application/json' },
    body: JSON.stringify({ email: creds.email, pass: creds.pass, cod_cli: creds.codcli }),
  });

  const txt = await r.text().catch(() => '');
  let json; try { json = JSON.parse(txt); } catch {}
  if (!r.ok || json?.resultCode !== 'SUCCESS') {
    const e = new Error(json?.resultDescription || r.statusText || 'login Maxi falló');
    e.status = 502; throw e;
  }

  const token = json?.content?.tokenAccess;
  if (!token) { const e = new Error('token Maxi vacío'); e.status = 502; throw e; }

  tokenCache.set(creds.key, { token, exp: now + 9*60*1000 });
  return token;
}

// ---------- fetch de 7 días con retry ----------
async function fetchFullByDate(fromYMD, toYMD, bearer) {
  const url = `${STATS_BASE.replace(/\/+$/, '')}/estadisticas/fullinvoicebydate?from=${encodeURIComponent(fromYMD)}&to=${encodeURIComponent(toYMD)}`;
  for (let i = 0; i < 3; i++) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${bearer}` } });
    const txt = await r.text().catch(() => ''); let j; try { j = JSON.parse(txt); } catch {}
    if (r.ok && (!j?.resultCode || j?.resultCode === 'SUCCESS')) {
      return j?.content ?? j ?? {};
    }
    if ([429,502,503].includes(r.status)) { // reintentos en errores transitorios
      await new Promise(res => setTimeout(res, 500 * (i+1)**2));
      continue;
    }
    const e = new Error(j?.resultDescription || r.statusText || txt || 'error Maxi');
    e.status = r.status || 502; throw e;
  }
  const e = new Error('Maxi retries exhausted'); e.status = 502; throw e;
}

// Particiona el rango en ventanas de 7 días y descarga con concurrencia fija
async function fetchRange(fromYMD, toYMD, bearer, conc = 2) {
  const start = new Date(fromYMD), end = new Date(toYMD);
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
  return results;
}

// ---------- extractor defensivo ----------
function extractItems(content) {
  const out = [];
  const push = (fecha, id, qty) => {
    const nId = Number(id), nQty = Number(qty);
    if (fecha && Number.isFinite(nId) && Number.isFinite(nQty)) {
      out.push({ fecha: String(fecha).slice(0,10), articuloId: nId, cantidad: nQty });
    }
  };

  const facturas = content?.facturas ?? content?.content?.facturas ?? [];
  if (Array.isArray(facturas)) {
    for (const f of facturas) {
      const fechaCab = f?.factura?.cabecera?.fecha || f?.fecha || f?.factura?.fecha;
      const items = f?.factura?.items ?? f?.items ?? [];
      for (const it of (items || [])) {
        const id  = it.cod_art ?? it.codigoArticulo ?? it.articuloId ?? it.idArticulo ?? it.codigo ?? it.id;
        const qty = it.cantidad ?? it.unidades ?? it.qty ?? it.cantidadVendida;
        push(fechaCab, id, qty);
      }
    }
  }

  // fallback súper defensivo
  if (!out.length) {
    const walk = (node, ctxFecha) => {
      if (!node) return;
      if (Array.isArray(node)) { node.forEach(n => walk(n, ctxFecha)); return; }
      if (typeof node === 'object') {
        const fecha = node.cabecera?.fecha?.slice?.(0,10)
          || node.fecha?.slice?.(0,10)
          || node.fechaDocumento?.slice?.(0,10)
          || ctxFecha;
        const id  = node.cod_art ?? node.codigoArticulo ?? node.articuloId ?? node.idArticulo ?? node.codigo ?? node.id;
        const qty = node.cantidad ?? node.unidades ?? node.qty ?? node.cantidadVendida;
        if (id != null && qty != null && fecha) push(fecha, id, qty);
        for (const k of Object.keys(node)) {
          if (['items','detalle','detalles','lineas','detalleFactura'].includes(k)) walk(node[k], fecha);
        }
      }
    };
    walk(content, null);
  }

  return out;
}

// ---------- handler principal ----------
exports.getVentas = async (req, res) => {
  try {
    const { from, to, articuloId, codigo, code, q, groupBy='day', ignoreZero, peek, limit } = req.query;
    const { from: F, to: T, AYER } = clampToAyer({ from, to });

    const creds = getBizCreds(req);
    if (!creds.email || !creds.pass || !creds.codcli) {
      return res.status(400).json({ error: 'Faltan credenciales Maxi para este comercio' });
    }
    const bearer = await maxiLogin(creds);

    // Descarga del rango completo (7d por ventana)
    const payloads = await fetchRange(F, T, bearer, 2);
    const lines = payloads.flatMap(extractItems);

    const targetId   = (articuloId != null) ? Number(articuloId) : null;
    const targetCode = (codigo ?? code)?.toString()?.trim()?.toUpperCase() || null;
    const textQ      = q?.toString()?.trim()?.toLowerCase() || null;

    // ---- modo peek: ranking de artículos (no por día) ----
    if (String(peek) === 'true') {
      const agg = new Map(); // id -> qty total
      for (const l of lines) {
        agg.set(l.articuloId, (agg.get(l.articuloId) || 0) + Number(l.cantidad || 0));
      }
      let items = Array.from(agg.entries()).map(([id, qty]) => ({ articuloId: id, qty }));
      if (targetId != null) items = items.filter(x => x.articuloId === targetId);
      // (podrías filtrar por code/name acá si tuvieras mapeo)
      items.sort((a,b) => b.qty - a.qty);
      const LIM = Math.min(Number(limit || 200), 1000);
      items = items.slice(0, LIM);

      return res.json({
        rango: { from: F, to: T, clampTo: AYER },
        filtro: { articuloId: targetId, codigo: targetCode, q: textQ },
        count: items.length,
        peek: items,
      });
    }

    // ---- serie por día (lo usa el gráfico y la tabla) ----
    const filtered = lines.filter(l => {
      if (targetId != null && l.articuloId !== targetId) return false;
      if (targetCode) return false; // placeholder para mapear código->id
      if (textQ) return false;      // placeholder para búsqueda por nombre
      return true;
    });

    const byDay = new Map();
    for (const it of filtered) {
      const k = it.fecha;
      byDay.set(k, (byDay.get(k) || 0) + Number(it.cantidad || 0));
    }

    const days = [];
    for (let d = new Date(F); d <= new Date(T); d = addDays(d, 1)) days.push(ymd(d));
    let data = days.map(date => ({ date, qty: byDay.get(date) || 0, amount: 0 }));
    if (String(ignoreZero) === 'true') data = data.filter(x => x.qty);

    const totals = data.reduce((acc, x) => (acc.qty += x.qty, acc), { qty: 0, amount: 0 });

    return res.json({
      rango: { from: F, to: T, clampTo: AYER },
      articuloId: targetId,
      codigo: targetCode,
      groupBy: 'day',
      ignoreZero: String(ignoreZero) === 'true',
      totals,
      data,
    });
  } catch (err) {
    console.error('getVentas error:', err);
    res.status(err.status || 500).json({ error: err.message || 'internal' });
  }
};
