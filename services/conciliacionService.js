// services/conciliacionService.js
// Guardado del módulo de conciliación bancaria (14/11/2026). El cruce lo hace el front
// (ModuloConciliacion, de Diego); acá solo se guarda por negocio lo que se subió, el trabajo de
// cada período y la memoria de pagadores. Ver migraciones 121_conciliacion.sql y 123 (por sucursal).
// Todo va por SUCURSAL: sucursal 0 = la principal, > 0 = app_branches.id (cada una tiene su
// propia cuenta de Mercado Pago).
'use strict';

const pool = require('../config/db');

const TIPOS = ['ventas', 'pagos', 'banco', 'facturas_cc', 'egresos'];
const MAX_FILAS = 100000;
const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;
const RE_PERIODO = /^(\d{4}-\d{2}-\d{2})?\|(\d{4}-\d{2}-\d{2})?$/;

const fechaOk = (f) => (typeof f === 'string' && RE_FECHA.test(f) ? f : null);

/** Valida una fuente subida. Devuelve { fila } o { error }. */
function validarFuente(tipo, body = {}) {
  if (!TIPOS.includes(tipo)) return { error: 'tipo_invalido' };
  const filas = body.filas;
  if (!Array.isArray(filas)) return { error: 'faltan_filas' };
  if (filas.length > MAX_FILAS) return { error: 'demasiadas_filas' };
  if (filas.some((f) => !f || typeof f !== 'object' || Array.isArray(f))) return { error: 'fila_invalida' };
  const fechas = filas.map((f) => f.fecha).filter((f) => typeof f === 'string' && RE_FECHA.test(f)).sort();
  return {
    fila: {
      tipo,
      archivo: typeof body.archivo === 'string' ? body.archivo.slice(0, 200) : null,
      filas,
      cantidad: filas.length,
      desde: fechaOk(body.desde) || fechas[0] || null,
      hasta: fechaOk(body.hasta) || fechas[fechas.length - 1] || null,
    },
  };
}

/** sucursal válida del negocio: 0 (principal) o una app_branches del mismo negocio. */
async function validarSucursal(businessId, raw) {
  if (raw === undefined || raw === null || raw === '' || raw === 'main') return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return null;
  if (n === 0) return 0;
  const { rows } = await pool.query('SELECT 1 FROM app_branches WHERE id = $1 AND business_id = $2', [n, businessId]);
  return rows.length ? n : null;
}

function validarPeriodo(p) {
  return typeof p === 'string' && RE_PERIODO.test(p) ? p : null;
}

/** Todo lo que el módulo necesita al abrir: las fuentes y la memoria de pagadores. */
async function cargar(businessId, sucursal = 0) {
  const { rows } = await pool.query(
    `SELECT tipo, archivo, filas, cantidad, desde::text AS desde, hasta::text AS hasta, origen, updated_at
       FROM conciliacion_fuentes WHERE business_id = $1 AND sucursal = $2`, [businessId, sucursal]);
  const fuentes = {};
  rows.forEach((r) => { fuentes[r.tipo] = r; });
  const pag = await pool.query('SELECT mapa FROM conciliacion_pagadores WHERE business_id = $1 AND sucursal = $2', [businessId, sucursal]);
  const per = await pool.query(
    'SELECT periodo, updated_at FROM conciliacion_estado WHERE business_id = $1 AND sucursal = $2 ORDER BY updated_at DESC LIMIT 24', [businessId, sucursal]);
  const traslados = await trasladosDe(businessId, sucursal);
  return { fuentes, pagadores: pag.rows[0]?.mapa || {}, periodos: per.rows, traslados };
}

async function guardarFuente(businessId, sucursal, userId, fila) {
  await pool.query(
    `INSERT INTO conciliacion_fuentes (business_id, tipo, archivo, filas, cantidad, desde, hasta, subido_por, sucursal, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, now())
     ON CONFLICT (business_id, sucursal, tipo) DO UPDATE SET
       archivo = EXCLUDED.archivo, filas = EXCLUDED.filas, cantidad = EXCLUDED.cantidad,
       desde = EXCLUDED.desde, hasta = EXCLUDED.hasta, subido_por = EXCLUDED.subido_por,
       origen = 'archivo', updated_at = now()`,
    [businessId, fila.tipo, fila.archivo, JSON.stringify(fila.filas), fila.cantidad, fila.desde, fila.hasta, userId || null, sucursal]);
  return { ok: true, tipo: fila.tipo, cantidad: fila.cantidad, desde: fila.desde, hasta: fila.hasta };
}

async function borrarFuente(businessId, sucursal, tipo) {
  if (!TIPOS.includes(tipo)) return { error: 'tipo_invalido' };
  await pool.query('DELETE FROM conciliacion_fuentes WHERE business_id = $1 AND sucursal = $2 AND tipo = $3', [businessId, sucursal, tipo]);
  return { ok: true };
}

async function leerEstado(businessId, sucursal, periodo) {
  const { rows } = await pool.query(
    'SELECT estado, updated_at FROM conciliacion_estado WHERE business_id = $1 AND sucursal = $2 AND periodo = $3', [businessId, sucursal, periodo]);
  return rows[0] ? { estado: rows[0].estado, updated_at: rows[0].updated_at } : { estado: null };
}

async function guardarEstado(businessId, sucursal, userId, periodo, estado) {
  await pool.query(
    `INSERT INTO conciliacion_estado (business_id, sucursal, periodo, estado, updated_by, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, now())
     ON CONFLICT (business_id, sucursal, periodo) DO UPDATE SET estado = EXCLUDED.estado, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [businessId, sucursal, periodo, JSON.stringify(estado), userId || null]);
  return { ok: true };
}

async function guardarPagadores(businessId, sucursal, mapa) {
  await pool.query(
    `INSERT INTO conciliacion_pagadores (business_id, sucursal, mapa, updated_at) VALUES ($1, $2, $3::jsonb, now())
     ON CONFLICT (business_id, sucursal) DO UPDATE SET mapa = EXCLUDED.mapa, updated_at = now()`,
    [businessId, sucursal, JSON.stringify(mapa)]);
  return { ok: true };
}

// ── Traslados entre PDV (Diego 20/11/2026) ──────────────────────────────────────────────────────
// Una fila (venta, movimiento del banco o cobro de cta. cte.) que se manda de la conciliación de una
// sucursal a otra: el origen deja de verla (salen) y el destino la recibe entera (entran).
const TIPOS_TRASLADO = ['ventas', 'banco', 'pagos'];

async function trasladosDe(businessId, sucursal) {
  // 20/11: el destino puede ser otro negocio de la organización (hacia_bid).
  const { rows } = await pool.query(
    `SELECT t.tipo, t.clave, t.business_id, t.desde_suc, COALESCE(t.hacia_bid, t.business_id) AS hacia_bid, t.hacia_suc, t.fila,
            ob.name AS desde_negocio
       FROM conciliacion_traslados t
       JOIN app_businesses ob ON ob.id = t.business_id
      WHERE (t.business_id = $1 AND t.desde_suc = $2) OR (COALESCE(t.hacia_bid, t.business_id) = $1 AND t.hacia_suc = $2)`,
    [businessId, sucursal]);
  const aca = (bid, suc) => bid === businessId && suc === sucursal;
  return {
    salen: rows.filter((r) => aca(r.business_id, r.desde_suc) && !aca(r.hacia_bid, r.hacia_suc))
      .map((r) => ({ tipo: r.tipo, clave: r.clave, haciaBid: r.hacia_bid, hacia: r.hacia_suc })),
    entran: rows.filter((r) => aca(r.hacia_bid, r.hacia_suc) && !aca(r.business_id, r.desde_suc))
      .map((r) => ({ tipo: r.tipo, clave: r.clave, desdeBid: r.business_id, desde: r.desde_suc, desdeNegocio: r.desde_negocio, fila: r.fila })),
  };
}

function validarTraslado(body = {}) {
  const items = Array.isArray(body.items) ? body.items : null;
  if (!items || !items.length || items.length > 500) return { error: 'items_invalidos' };
  for (const it of items) {
    if (!it || !TIPOS_TRASLADO.includes(it.tipo) || typeof it.clave !== 'string' || !it.clave || it.clave.length > 300) return { error: 'item_invalido' };
    if (!it.fila || typeof it.fila !== 'object' || Array.isArray(it.fila)) return { error: 'fila_invalida' };
  }
  return { items };
}

/** PDV a los que se puede mandar: todas las sucursales de todos los negocios de la organización
 *  (la sucursal is_main de cada negocio es la 0). */
async function destinosOrg(businessId) {
  const { rows } = await pool.query(
    `SELECT b.id AS bid, b.name AS negocio, br.id AS branch_id, br.name AS sucursal, COALESCE((br.props->>'is_main')::boolean, false) AS es_main
       FROM app_businesses b
       LEFT JOIN app_branches br ON br.business_id = b.id
      WHERE b.id = $1 OR (b.organization_id IS NOT NULL AND b.organization_id = (SELECT organization_id FROM app_businesses WHERE id = $1))
      ORDER BY (b.id = $1) DESC, b.name, es_main DESC, br.name`, [businessId]);
  const out = [];
  const vistos = new Set();
  // los id pueden venir como texto (bigint): todo a número para comparar
  rows.forEach((r) => { r.bid = Number(r.bid); r.branch_id = r.branch_id == null ? null : Number(r.branch_id); });
  rows.forEach((r) => {
    const suc = !r.branch_id || r.es_main ? 0 : r.branch_id;
    const k = r.bid + ':' + suc;
    if (vistos.has(k)) return;
    vistos.add(k);
    out.push({ bid: r.bid, suc, negocio: r.negocio, nombre: r.branch_id ? r.sucursal : r.negocio });
  });
  // un negocio con sucursales pero sin is_main: igual tiene su principal (0)
  [...new Set(rows.map((r) => r.bid))].forEach((bid) => {
    if (!vistos.has(bid + ':0')) { const r = rows.find((x) => x.bid === bid); out.push({ bid, suc: 0, negocio: r.negocio, nombre: r.negocio }); }
  });
  return out;
}

/** Manda las filas de (businessId, desde) a (haciaBid, hacia). Una fila que había llegado de otro PDV
 *  se re-dirige; si vuelve a su PDV de origen, el traslado se borra. Una sola transacción. */
async function trasladar(businessId, desde, haciaBid, hacia, userId, items) {
  const client = await pool.connect();
  let movidos = 0, devueltos = 0, total = 0;
  try {
    await client.query('BEGIN');
    for (const it of items) {
      // ¿llegó acá desde otro PDV? (se busca por destino actual) — si no, nace acá
      const prev = await client.query(
        `SELECT business_id, desde_suc FROM conciliacion_traslados
          WHERE tipo = $1 AND clave = $2 AND COALESCE(hacia_bid, business_id) = $3 AND hacia_suc = $4 FOR UPDATE`,
        [it.tipo, it.clave, businessId, desde]);
      const oBid = prev.rows[0] ? prev.rows[0].business_id : businessId;
      const oSuc = prev.rows[0] ? prev.rows[0].desde_suc : desde;
      const imp = Number(it.fila.imp ?? it.fila.importe) || 0;
      total += imp;
      if (oBid === haciaBid && oSuc === hacia) {
        await client.query('DELETE FROM conciliacion_traslados WHERE business_id = $1 AND tipo = $2 AND clave = $3', [oBid, it.tipo, it.clave]);
        devueltos++;
      } else {
        const fecha = RE_FECHA.test(String(it.fila.fecha || '')) ? it.fila.fecha : null;
        const fila = { ...it.fila };
        delete fila.trasladoDesde; delete fila.trasladoNegocio;
        await client.query(
          `INSERT INTO conciliacion_traslados (business_id, tipo, clave, desde_suc, hacia_bid, hacia_suc, fila, fecha, importe, creado_por, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, now())
           ON CONFLICT (business_id, tipo, clave) DO UPDATE SET hacia_bid = EXCLUDED.hacia_bid, hacia_suc = EXCLUDED.hacia_suc,
             fila = EXCLUDED.fila, creado_por = EXCLUDED.creado_por, updated_at = now()`,
          [oBid, it.tipo, it.clave, oSuc, haciaBid, hacia, JSON.stringify(fila), fecha, imp, userId || null]);
        movidos++;
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  return { ok: true, movidos, devueltos, total };
}

/** Nombre de una sucursal para los avisos (0 = la principal). */
async function nombreSucursal(businessId, sucursal) {
  if (!sucursal) {
    const { rows } = await pool.query('SELECT name FROM app_businesses WHERE id = $1', [businessId]);
    return rows[0]?.name || 'la principal';
  }
  const { rows } = await pool.query('SELECT name FROM app_branches WHERE id = $1 AND business_id = $2', [sucursal, businessId]);
  return rows[0]?.name || `sucursal ${sucursal}`;
}

module.exports = {
  TIPOS_TRASLADO, trasladosDe, validarTraslado, trasladar, nombreSucursal, destinosOrg,
  TIPOS, validarFuente, validarPeriodo, validarSucursal,
  cargar, guardarFuente, borrarFuente, leerEstado, guardarEstado, guardarPagadores,
};
