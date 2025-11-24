/* eslint-disable no-console */
'use strict';

const { STATS_BASE, getBearer } = require('./maxiSalesService');

// usa fetch nativo o node-fetch como en maxiSalesService
const fetchNative =
  (typeof globalThis.fetch === 'function')
    ? ((...args) => globalThis.fetch(...args))
    : require('node-fetch');

/* ========== Helpers genéricos ========== */
function extractContent(payload) {
  if (!payload) return [];
  const c1 = payload?.content ?? payload;
  const c2 = c1?.content ?? c1;
  if (Array.isArray(c2)) return c2;
  return [];
}

/* ========== INSUMOS ========== */
function extractInsumosPayload(payload) {
  // Por ahora es igual, pero lo dejamos separado por si Maxi cambia algo
  return extractContent(payload);
}

/**
 * fetchMaxiInsumos({ businessId, req })
 * - Pide token con getBearer
 * - Llama a /estadisticasmaster/insumos
 * - Devuelve array de insumos raw
 */
async function fetchMaxiInsumos({ businessId, req }) {
  if (!businessId) {
    const e = new Error('businessId requerido para fetchMaxiInsumos');
    e.status = 400;
    throw e;
  }

  const bearer = await getBearer(businessId, req);
  const url = `${STATS_BASE}/estadisticasmaster/insumos`;

  console.log('[maxiSupplies] GET', url);

  const r = await fetchNative(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${bearer}`,
      Accept: 'application/json',
    },
  });

  const txt = await r.text().catch(() => '');
  let j;
  try {
    j = JSON.parse(txt);
  } catch {
    j = null;
  }

  const ok = r.ok && (!j?.resultCode || j?.resultCode === 'SUCCESS');

  if (!ok) {
    const err = new Error(j?.resultDescription || r.statusText || 'Error Maxi insumos');
    err.status = r.status || 502;
    err._maxi = {
      status: r.status,
      url,
      bodyPreview: String(txt).slice(0, 300),
    };
    throw err;
  }

  const insumos = extractInsumosPayload(j);
  console.log('[maxiSupplies] Insumos recibidos:', Array.isArray(insumos) ? insumos.length : 0);

  return Array.isArray(insumos) ? insumos : [];
}

/**
 * normalizarInsumosMaxi(items)
 * - Convierte a un shape consistente para guardar en DB
 */
function normalizarInsumosMaxi(items = []) {
  return items
    .map((it) => {
      const codigo = Number(it.codigo);
      if (!Number.isFinite(codigo)) return null;

      return {
        codigo,
        nombre: typeof it.nombre === 'string' ? it.nombre.trim() : '',
        rubro: it.rubro != null ? Number(it.rubro) : null,
        medida: it.medida || null,
        precio: it.precio != null ? Number(it.precio) : null,
        iva: it.iva || '',
        imp_int: it.imp_int != null ? Number(it.imp_int) : null,
        discontinuado: Number(it.discontinuado) === 1,
        raw: it,
      };
    })
    .filter(Boolean);
}

/* ========== RUBROS DE INSUMOS ========== */

function extractInsumosRubrosPayload(payload) {
  return extractContent(payload);
}

/**
 * GET /estadisticasmaster/rubrodeinsumos
 */
async function fetchMaxiInsumosRubros({ businessId, req }) {
  if (!businessId) {
    const e = new Error('businessId requerido para fetchMaxiInsumosRubros');
    e.status = 400;
    throw e;
  }

  const bearer = await getBearer(businessId, req);
  const url = `${STATS_BASE}/estadisticasmaster/rubrodeinsumos`;

  console.log('[maxiSupplies] GET', url);

  const r = await fetchNative(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${bearer}`,
      Accept: 'application/json',
    },
  });

  const txt = await r.text().catch(() => '');
  let j;
  try {
    j = JSON.parse(txt);
  } catch {
    j = null;
  }

  const ok = r.ok && (!j?.resultCode || j?.resultCode === 'SUCCESS');

  if (!ok) {
    const err = new Error(j?.resultDescription || r.statusText || 'Error Maxi rubros de insumos');
    err.status = r.status || 502;
    err._maxi = {
      status: r.status,
      url,
      bodyPreview: String(txt).slice(0, 300),
    };
    throw err;
  }

  const rubros = extractInsumosRubrosPayload(j);
  console.log('[maxiSupplies] Rubros de insumos recibidos:', Array.isArray(rubros) ? rubros.length : 0);

  return Array.isArray(rubros) ? rubros : [];
}

/**
 * normalizarInsumosRubros(items)
 * - Convierte rubros de insumos al shape de nuestra tabla insumo_rubros
 * - Marca es_elaborador cuando el nombre empieza por "Elaborados"
 */
function normalizarInsumosRubros(items = []) {
  return items
    .map((it) => {
      const codigo = Number(it.codigo);
      if (!Number.isFinite(codigo)) return null;

      const nombre = typeof it.nombre === 'string' ? it.nombre.trim() : '';
      const cpto_caja = it.cptoCaja != null ? Number(it.cptoCaja) : null;
      const es_elaborador = /^elaborad/i.test(nombre);

      return {
        codigo,
        nombre,
        cpto_caja,
        es_elaborador,
        activo: true,
      };
    })
    .filter(Boolean);
}

module.exports = {
  fetchMaxiInsumos,
  normalizarInsumosMaxi,
  fetchMaxiInsumosRubros,
  normalizarInsumosRubros,
};
