// controllers/ventasController.js
const fetch = require('node-fetch');

// Bases Maxirest
const MAXI_BASE = process.env.MAXI_BASE_URL || 'https://api-mconn.maxisistemas.com.ar';
const STATS_BASE = process.env.MAXI_STATS_BASE_URL || 'https://api-mconn.maxisistemas.com.ar/estadisticas';

// Cache de tokens por negocio
const maxiTokenCache = new Map(); // key: businessId -> { token, exp }

// Obtiene las credenciales Maxi del negocio activo (ajusta a tu modelo/DAO)
async function readMaxiCreds(req) {
  // Preferí id de negocio por URL (/api/businesses/:id/...) o el activo en sesión
  const businessId = Number(req.params.id ?? req.user?.active_business_id ?? req.query.businessId);
  if (!businessId) throw new Error('Falta businessId para login Maxi');

  // TODO: Reemplaza por tu acceso real a DB
  const biz = await req.db.Business.findByPk(businessId); // <- ejemplo
  if (!biz?.maxi_email || !biz?.maxi_pass || !biz?.maxi_codcli) {
    const e = new Error('Credenciales Maxi no configuradas');
    e.status = 400;
    throw e;
  }
  return { businessId, email: biz.maxi_email, pass: biz.maxi_pass, cod_cli: biz.maxi_codcli };
}

async function loginMaxi({ email, pass, cod_cli }) {
  const url = `${MAXI_BASE}/login`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, pass, cod_cli })
  });
  const txt = await r.text(); let json; try { json = JSON.parse(txt); } catch {}
  if (!r.ok || json?.resultCode !== 'SUCCESS') {
    const msg = json?.resultDescription || txt || r.statusText || 'Login Maxi error';
    const e = new Error(msg); e.status = 502; throw e;
  }
  const token = json?.content?.tokenAccess;
  if (!token) { const e = new Error('Login Maxi sin tokenAccess'); e.status = 502; throw e; }
  return token;
}

async function getToken(req) {
  const { businessId, email, pass, cod_cli } = await readMaxiCreds(req);
  const now = Date.now();
  const hit = maxiTokenCache.get(businessId);
  if (hit && hit.exp > now) return hit.token;

  const token = await loginMaxi({ email, pass, cod_cli });
  // Cache 9 minutos (API reporta 3600s, con margen)
  maxiTokenCache.set(businessId, { token, exp: now + 9 * 60 * 1000 });
  return token;
}

// Utilidades de fechas
const toDate = (s) => new Date(`${s}T00:00:00`);
const fmtYMD = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate()+n); return x; };

// Extractor robusto para facturas -> líneas
function extractFacturas(payload) {
  const facturas =
    payload?.content?.content?.facturas ??
    payload?.content?.facturas ?? 
    payload?.facturas ?? [];

  const out = [];
  for (const f of facturas) {
    const fac = f?.factura ?? f;
    const fechaCab = fac?.cabecera?.fecha;                     // "2025-08-07"
    const fechaItem = fac?.fecha?.slice?.(0,10);               // "07/08/2025" a veces no ISO
    const fYMD = (fechaCab && fechaCab.length === 10) ? fechaCab
               : (fechaItem ? fechaItem.replace(/(\d{2})\/(\d{2})\/(\d{4})/, '$3-$2-$1') : null);

    const items = fac?.items ?? fac?.detalle ?? fac?.detalles ?? [];
    for (const it of items) {
      const cod = it.cod_art ?? it.codigoArticulo ?? it.articuloId ?? it.codigo ?? it.id;
      const qty = Number(it.cantidad ?? it.qty ?? it.unidades ?? 0);
      const precio = Number(it.precio ?? it.importe ?? 0);
      if (fYMD && Number.isFinite(qty) && cod != null) {
        out.push({ fechaYMD: fYMD, cod_art: String(cod), cantidad: qty, precio });
      }
    }
  }
  return out;
}

// Trae todas las líneas entre from..to, en ventanas de máx 7 días
async function fetchStatsAll({ from, to, req }) {
  const token = await getToken(req);
  const bearer = `Bearer ${token}`;

  const start = toDate(from);
  const end   = toDate(to);
  let cursor = new Date(start);

  const all = [];
  while (cursor <= end) {
    const cStart = new Date(cursor);
    const cEnd = addDays(cursor, 6);
    const stop = (cEnd < end ? cEnd : end);

    const url = new URL(`${STATS_BASE}/fullinvoicebydate`);
    url.searchParams.set('from', fmtYMD(cStart));
    url.searchParams.set('to', fmtYMD(stop));

    const r = await fetch(url.toString(), { headers: { Authorization: bearer } });
    const txt = await r.text(); let json; try { json = JSON.parse(txt); } catch {}
    if (!r.ok) {
      const e = new Error(json?.resultDescription || txt || r.statusText || 'Maxi fullinvoicebydate error');
      e.status = 502; throw e;
    }
    all.push(...extractFacturas(json));
    cursor = addDays(stop, 1);
  }
  return all; // [{fechaYMD, cod_art, cantidad, precio}, ...]
}

// Helpers para la agregación diaria por artículo/código
function groupByDayForArticulo(lines, { targetId, targetCode }) {
  const byDay = new Map();
  let totalQty = 0, totalAmount = 0;

  const match = (line) => {
    if (targetId != null)  return String(line.cod_art) === String(targetId);
    if (targetCode)        return String(line.cod_art).trim() === String(targetCode).trim();
    return true;
  };

  for (const l of lines) {
    if (!match(l)) continue;
    const key = l.fechaYMD;
    const prev = byDay.get(key) || { date: key, qty: 0, amount: 0 };
    prev.qty += Number(l.cantidad || 0);
    prev.amount += Number(l.precio || 0) * Number(l.cantidad || 0);
    byDay.set(key, prev);
    totalQty += Number(l.cantidad || 0);
    totalAmount += Number(l.precio || 0) * Number(l.cantidad || 0);
  }
  return { byDay: Array.from(byDay.values()).sort((a,b)=>a.date.localeCompare(b.date)), totalQty, totalAmount };
}

function dateRangeDays(from, to) {
  const s = toDate(from), e = toDate(to);
  const out = [];
  for (let d = new Date(s); d <= e; d = addDays(d,1)) out.push(fmtYMD(d));
  return out;
}

function clampToAyer({ from, to }) {
  const AYER = fmtYMD(addDays(new Date(), -1));
  const F = from || fmtYMD(addDays(new Date(AYER), -29)); // default: últimos 30 días hasta ayer
  const T = to && to < AYER ? to : AYER;
  return { from: F, to: T, AYER };
}

/**
 * GET /api/ventas
 * query:
 *   - articuloId?  OR  codigo?/articuloCode?/code?  OR  q? (texto)  [para basic/peek]
 *   - from?, to?  (YYYY-MM-DD; clamp a AYER)
 *   - groupBy=day (único soportado para series)
 *   - basic=true | peek=true
 *   - ignoreZero=true|false
 *   - probe=true (diagnóstico rápido)
 *   - limit? (para basic/peek)
 */
exports.getVentas = async (req, res) => {
  try {
    let { articuloId, codigo, articuloCode, code, q, from, to, groupBy='day', ignoreZero, basic, peek, limit, probe } = req.query;
    const { from: F, to: T, AYER } = clampToAyer({ from, to });

    const codeRaw = codigo ?? articuloCode ?? code;
    const target = {
      targetId: (articuloId ?? '') !== '' ? String(articuloId) : null,
      targetCode: codeRaw ? String(codeRaw).trim() : null,
      q: q ? String(q) : null
    };

    if (String(probe) === 'true') {
      // Sonda básica para confirmar si el proveedor devuelve facturas
      const lines = await fetchStatsAll({ from: F, to: T, req });
      return res.json({ rango: { from: F, to: T, clampTo: AYER }, probe: { count: lines.length, sample: lines[0] ?? null } });
    }

    // Básico y peek operan sobre el total de líneas crudas (para autocompletar, etc.)
    if (String(basic) === 'true' || String(peek) === 'true') {
      const LIM = Math.min(Number(limit || 200), 1000);
      const lines = await fetchStatsAll({ from: F, to: T, req });

      if (String(peek) === 'true') {
        // Distintos items por cod_art
        const set = new Map();
        for (const l of lines) if (!set.has(l.cod_art)) set.set(l.cod_art, { cod: String(l.cod_art) });
        const peekArr = Array.from(set.values()).slice(0, LIM);
        return res.json({ rango: { from: F, to: T, clampTo: AYER }, filtro: target, count: peekArr.length, peek: peekArr });
      }

      // basic: top por coincidencia con q/código
      const matches = [];
      for (const l of lines) {
        if (target.targetCode && String(l.cod_art) !== target.targetCode) continue;
        if (target.q && !String(l.cod_art).includes(target.q)) continue; // (si luego querés usar nombre, guardalo también al extraer)
        matches.push({ cod: String(l.cod_art) });
      }
      // únicos
      const uniq = Array.from(new Map(matches.map(m => [m.cod, m])).values()).slice(0, LIM);
      return res.json({ rango: { from: F, to: T, clampTo: AYER }, filtro: target, count: uniq.length, basic: uniq });
    }

    // Series por día
    if (groupBy !== 'day') return res.status(400).json({ error: 'Sólo groupBy=day soportado' });

    const lines = await fetchStatsAll({ from: F, to: T, req });
    const agg = groupByDayForArticulo(lines, target);
    const days = dateRangeDays(F, T);
    const filled = days.map(d => agg.byDay.find(x => x.date === d) || { date: d, qty: 0, amount: 0 });
    const out = (String(ignoreZero) === 'true') ? filled.filter(x => x.qty && x.amount) : filled;

    res.json({
      rango: { from: F, to: T, clampTo: AYER },
      articuloId: target.targetId,
      codigo: target.targetCode,
      groupBy: 'day',
      ignoreZero: String(ignoreZero) === 'true',
      totals: { qty: agg.totalQty, amount: agg.totalAmount },
      data: out
    });
  } catch (e) {
    console.error('getVentas error:', e);
    res.status(e.status || 500).json({ error: e.message || 'Error interno' });
  }
};
