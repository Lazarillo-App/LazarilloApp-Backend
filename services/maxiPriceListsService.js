'use strict';

const { getBearer } = require('./maxiSalesService');

const MAXI_BASE = (process.env.MAXI_BASE_URL || 'https://api-mconn.maxisistemas.com.ar').replace(/\/+$/, '');

const fetchNative =
  typeof globalThis.fetch === 'function'
    ? (...args) => globalThis.fetch(...args)
    : require('node-fetch');

/**
 * Trae todos los artículos con sus 4 precios desde Maxi.
 * Solo devuelve los campos necesarios: id, codigo, nombre, precio1..4
 */
async function fetchMaxiPriceLists({ businessId, req }) {
  const bearer = await getBearer(businessId, req);
  const url = `${MAXI_BASE}/estadisticasmaster/articulos`;

  const r = await fetchNative(url, {
    headers: {
      Authorization: `Bearer ${bearer}`,
      Accept: 'application/json',
    },
  });

  const txt = await r.text().catch(() => '');
  let j;
  try { j = JSON.parse(txt); } catch {}

  if (!r.ok || j?.resultCode !== 'SUCCESS') {
    const e = new Error(j?.resultDescription || r.statusText || 'maxi price lists fetch failed');
    e.status = r.status || 502;
    throw e;
  }

  const items = Array.isArray(j?.content) ? j.content : [];

  // Solo los campos que necesitamos
  return items.map(a => ({
    id:      a.id,
    codigo:  a.codigo,
    nombre:  a.nombre,
    precio1: a.precio1 ?? 0,
    precio2: a.precio2 ?? 0,
    precio3: a.precio3 ?? 0,
    precio4: a.precio4 ?? 0,
  }));
}

module.exports = { fetchMaxiPriceLists };