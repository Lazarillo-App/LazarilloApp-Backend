// services/maxiPurchasesService.js
'use strict';

const { MAXI_BASE, getBearer } = require('./maxiSalesService');

const fetchNative =
  typeof globalThis.fetch === 'function'
    ? (...args) => globalThis.fetch(...args)
    : require('node-fetch');

function extractContent(payload) {
  if (!payload) return [];
  const c1 = payload?.content ?? payload;
  const c2 = c1?.content ?? c1;
  return Array.isArray(c2) ? c2 : [];
}

// Parte un rango en chunks de MAX_DAYS dias (limite de MaxiRest)
const MAX_DAYS = 7;

function splitRangeIntoChunks(from, to) {
  const chunks = [];
  let cur = new Date(from + 'T00:00:00');
  const end = new Date(to   + 'T00:00:00');
  const fmt = (d) => d.toISOString().slice(0, 10);

  while (cur <= end) {
    const chunkEnd = new Date(cur);
    chunkEnd.setDate(chunkEnd.getDate() + MAX_DAYS - 1);
    if (chunkEnd > end) chunkEnd.setTime(end.getTime());
    chunks.push({ from: fmt(cur), to: fmt(chunkEnd) });
    cur = new Date(chunkEnd);
    cur.setDate(cur.getDate() + 1);
  }
  return chunks;
}

// GET /estadisticasmaster/proveedores -> [{ codigo, nombre, rs, cuit }]
async function fetchMaxiSuppliers({ businessId, req }) {
  const bearer = await getBearer(businessId, req);
  const url = `${MAXI_BASE}/estadisticasmaster/proveedores`;
  console.log('[maxiPurchases] GET proveedores');
  const r = await fetchNative(url, {
    headers: { Authorization: `Bearer ${bearer}`, Accept: 'application/json' },
  });
  const txt = await r.text().catch(() => '');
  let j; try { j = JSON.parse(txt); } catch {}
  if (!r.ok) {
    const err = new Error(j?.resultDescription || `HTTP ${r.status} proveedores`);
    err.status = r.status || 502;
    throw err;
  }
  return extractContent(j);
}

// POST /estadisticas/compras (un chunk <= 7 dias)
async function fetchMaxiPurchasesChunk({ bearer, from, to, provdr = '', num = '' }) {
  const url = `${MAXI_BASE}/estadisticas/compras`;
  const r = await fetchNative(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${bearer}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ from, to, provdr: String(provdr), num: String(num) }),
  });
  const txt = await r.text().catch(() => '');
  let j; try { j = JSON.parse(txt); } catch {}
  if (!r.ok) {
    const err = new Error(j?.resultDescription || `HTTP ${r.status} compras ${from}->${to}`);
    err.status = r.status || 502;
    throw err;
  }
  return extractContent(j);
}

// Wrapper publica: parte el rango en chunks de 7 dias y los concatena
async function fetchMaxiPurchases({ businessId, req, from, to, provdr = '', num = '' }) {
  const bearer  = await getBearer(businessId, req);
  const chunks  = splitRangeIntoChunks(from, to);
  console.log(`[maxiPurchases] POST compras ${from} -> ${to} (${chunks.length} chunk/s)`);

  const all = [];
  for (const chunk of chunks) {
    console.log(`  chunk: ${chunk.from} -> ${chunk.to}`);
    const rows = await fetchMaxiPurchasesChunk({ bearer, from: chunk.from, to: chunk.to, provdr, num });
    all.push(...rows);
  }
  return all;
}

module.exports = { fetchMaxiSuppliers, fetchMaxiPurchases };