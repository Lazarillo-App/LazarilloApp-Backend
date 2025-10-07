// controllers/ventasController.js
const fetch = require('node-fetch');

const MAXI_BASE  = process.env.MAXI_BASE_URL  || 'https://api-mconn.maxisistemas.com.ar';
const STATS_BASE = process.env.MAXI_STATS_URL || 'https://api-mconn.maxisistemas.com.ar';

const tokenCache = new Map(); // key: businessId|env, value: {token, exp}

function safeYMD(d){ return String(d).slice(0,10); }
function clampToAyer({from,to}) {
  const hoy = new Date(); hoy.setHours(0,0,0,0);
  const AYER = new Date(hoy); AYER.setDate(AYER.getDate()-1);
  const F = from ? new Date(from) : new Date(AYER); F.setDate(F.getDate()-29);
  const T = to ? new Date(to) : AYER;
  const pad = n => String(n).padStart(2,'0');
  const fmt = x => `${x.getFullYear()}-${pad(x.getMonth()+1)}-${pad(x.getDate())}`;
  return { from: fmt(F), to: fmt(T), AYER: fmt(AYER) };
}

function getBizCreds(req) {
  const m = req.business?.props?.maxi || {};
  return {
    email:  m.email  || process.env.MAXI_EMAIL,
    pass:   m.pass   || process.env.MAXI_PASS,
    codcli: m.codcli || process.env.MAXI_CODCLI,
    key:    req.businessId ? `biz:${req.businessId}` : 'env'
  };
}

async function maxiLogin(creds) {
  // cache 9 minutos
  const now = Date.now();
  const cached = tokenCache.get(creds.key);
  if (cached && cached.exp > now) return cached.token;

  const r = await fetch(`${MAXI_BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type':'application/json' },
    body: JSON.stringify({ email: creds.email, pass: creds.pass, cod_cli: creds.codcli })
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok || json?.resultCode !== 'SUCCESS') {
    const msg = json?.resultDescription || 'login Maxi falló';
    const e = new Error(msg); e.status = 502; throw e;
  }
  const token = json?.content?.tokenAccess;
  if (!token) { const e = new Error('token Maxi vacío'); e.status = 502; throw e; }
  tokenCache.set(creds.key, { token, exp: now + 9*60*1000 });
  return token;
}

async function fetchFull(from, to, bearer) {
  const url = `${STATS_BASE}/estadisticas/fullinvoicebydate?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${bearer}` }});
  const txt = await r.text();
  let json; try { json = JSON.parse(txt); } catch { json = null; }
  if (!r.ok) { const e = new Error(json?.resultDescription || txt || 'error Maxi'); e.status = 502; throw e; }
  if (json?.resultCode && json.resultCode !== 'SUCCESS') {
    const e = new Error(json?.resultDescription || 'error Maxi'); e.status = 502; throw e;
  }
  return json?.content ?? json ?? {};
}

// extractor MUY permisivo (id fecha cantidad)
function extractItems(content) {
  const out = [];
  const push = (fecha, id, qty) => {
    const nId = Number(id); const nQty = Number(qty);
    if (fecha && Number.isFinite(nId) && Number.isFinite(nQty)) {
      out.push({ fecha: safeYMD(fecha), articuloId: nId, cantidad: nQty });
    }
  };
  const walk = (node, ctxFecha) => {
    if (!node) return;
    if (Array.isArray(node)) return node.forEach(n => walk(n, ctxFecha));
    if (typeof node === 'object') {
      const fecha = node.fecha?.slice?.(0,10) || node.fechaDocumento?.slice?.(0,10) || ctxFecha;
      const id = node.articuloId ?? node.cod_art ?? node.codigoArticulo ?? node.idArticulo ?? node.codigo ?? node.id;
      const qty = node.cantidad ?? node.cantidadVendida ?? node.qty ?? node.unidades;
      if (id != null && qty != null && fecha) push(fecha, id, qty);

      for (const k of Object.keys(node)) {
        if (['items','detalle','detalles','lineas','detalleFactura'].includes(k)) walk(node[k], fecha);
      }
    }
  };
  walk(content, null);
  return out;
}

exports.getVentas = async (req, res, next) => {
  try {
    // negocio requerido: ya lo garantiza requireBusiness
    const { from, to, articuloId, codigo, code, q, groupBy='day', ignoreZero } = req.query;
    const { from: F, to: T, AYER } = clampToAyer({ from, to });

    // credenciales Maxi por negocio o env
    const creds = getBizCreds(req);
    if (!creds.email || !creds.pass || !creds.codcli) {
      return res.status(400).json({ error: 'Faltan credenciales Maxi para este comercio' });
    }
    const bearer = await maxiLogin(creds);

    // Maxi limita a 7 días => particionamos
    const start = new Date(F); const end = new Date(T);
    const add = (d,n)=>{const x=new Date(d); x.setDate(x.getDate()+n); return x;};
    const fmt = d => d.toISOString().slice(0,10);

    const fullPayload = [];
    let cur = new Date(start);
    while (cur <= end) {
      const a = new Date(cur);
      const b = add(cur, 6);
      const stop = (b < end ? b : end);
      const chunk = await fetchFull(fmt(a), fmt(stop), bearer);
      fullPayload.push(chunk);
      cur = add(stop, 1);
    }

    // a) peek/basic / b) agregación por día
    const lines = extractItems(fullPayload);

    // filtros
    const targetId   = (articuloId != null) ? Number(articuloId) : null;
    const targetCode = (codigo ?? code)?.toString()?.trim()?.toUpperCase() || null;
    const textQ      = q?.toString()?.trim()?.toLowerCase() || null;

    const matches = lines.filter(l => {
      if (targetId != null && l.articuloId === targetId) return true;
      if (targetCode) return false;  // (si más adelante mapeás id por código)
      if (textQ) return false;       // (si más adelante buscás por nombre)
      return targetId == null && !targetCode && !textQ;
    });

    // agregación por día
    const bucket = new Map();
    for (const it of matches) {
      const key = it.fecha; // day
      bucket.set(key, (bucket.get(key) || 0) + Number(it.cantidad||0));
    }
    // rango completo con ceros
    const days = [];
    for (let d=new Date(start); d<=end; d=add(d,1)) days.push(fmt(d));
    const data = days.map(date => ({ date, qty: bucket.get(date)||0, amount: 0 }));

    const out = (String(ignoreZero)==='true') ? data.filter(x => x.qty) : data;
    const total = out.reduce((a,x)=>a+x.qty,0);

    return res.json({
      rango: { from: F, to: T, clampTo: AYER },
      articuloId: targetId,
      codigo: targetCode,
      groupBy: 'day',
      ignoreZero: String(ignoreZero)==='true',
      totals: { qty: total, amount: 0 },
      data: out
    });
  } catch (err) {
    next(err);
  }
};
