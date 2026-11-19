// services/movMarcas.js
// Marcas a mano sobre los movimientos bancarios (Diego 19/11/2026): por ahora «Gasto personal» en lo que salió.
// Se guardan por negocio + sucursal + id del movimiento (el mismo id que tienen en las fuentes de la conciliación).
'use strict';

const pool = require('../config/db');

const MARCAS = new Set(['personal']);

async function listar(businessId, sucursal) {
  const { rows } = await pool.query(
    'SELECT mov_id, marca FROM mov_marcas WHERE business_id = $1 AND sucursal = $2', [businessId, sucursal]);
  return { marcas: rows.map((r) => ({ id: r.mov_id, marca: r.marca })) };
}

/** Marca o desmarca un movimiento. Devuelve lo que cambió (para el aviso), o { sinCambios }. */
async function marcar(businessId, sucursal, { id, marca = 'personal', activo, importe, fecha } = {}, userId = null) {
  const mov = String(id || '').trim();
  if (!mov || mov.length > 200) return { error: 'movimiento_invalido' };
  if (!MARCAS.has(marca)) return { error: 'marca_invalida' };
  const imp = Number.isFinite(Number(importe)) ? Math.round(Math.abs(Number(importe)) * 100) / 100 : null;
  const f = /^\d{4}-\d{2}-\d{2}$/.test(String(fecha || '')) ? fecha : null;
  if (activo) {
    const r = await pool.query(
      `INSERT INTO mov_marcas (business_id, sucursal, mov_id, marca, importe, fecha, creado_por) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (business_id, sucursal, mov_id) DO NOTHING`, [businessId, sucursal, mov, marca, imp, f, userId]);
    return r.rowCount ? { ok: true, id: mov, activo: true, importe: imp, fecha: f } : { ok: true, sinCambios: true };
  }
  const r = await pool.query('DELETE FROM mov_marcas WHERE business_id = $1 AND sucursal = $2 AND mov_id = $3 RETURNING importe, fecha::text',
    [businessId, sucursal, mov]);
  return r.rowCount ? { ok: true, id: mov, activo: false, importe: imp ?? Number(r.rows[0].importe), fecha: f ?? r.rows[0].fecha } : { ok: true, sinCambios: true };
}

module.exports = { listar, marcar };
