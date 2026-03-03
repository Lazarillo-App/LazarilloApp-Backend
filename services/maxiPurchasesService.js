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

// POST /estadisticas/compras -> [{ proveedor, numero, items[] }]
async function fetchMaxiPurchases({ businessId, req, from, to, provdr = '', num = '' }) {
  const bearer = await getBearer(businessId, req);
  const url = `${MAXI_BASE}/estadisticas/compras`;
  console.log(`[maxiPurchases] POST compras ${from} -> ${to}`);
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
    const err = new Error(j?.resultDescription || `HTTP ${r.status} compras`);
    err.status = r.status || 502;
    throw err;
  }
  return extractContent(j);
}

module.exports = { fetchMaxiSuppliers, fetchMaxiPurchases };