// services/conciliacionService.js
// Guardado del módulo de conciliación bancaria (14/11/2026). El cruce lo hace el front
// (ModuloConciliacion, de Diego); acá solo se guarda por negocio lo que se subió, el trabajo de
// cada período y la memoria de pagadores. Ver migraciones 121_conciliacion.sql y 123 (por sucursal).
// Todo va por SUCURSAL: sucursal 0 = la principal, > 0 = app_branches.id (cada una tiene su
// propia cuenta de Mercado Pago).
'use strict';

const pool = require('../config/db');

const TIPOS = ['ventas', 'pagos', 'banco', 'facturas_cc'];
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
  return { fuentes, pagadores: pag.rows[0]?.mapa || {}, periodos: per.rows };
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

module.exports = {
  TIPOS, validarFuente, validarPeriodo, validarSucursal,
  cargar, guardarFuente, borrarFuente, leerEstado, guardarEstado, guardarPagadores,
};
