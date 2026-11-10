// services/tareasUnicas/costosPorLocal.js
//
// Tarea ÚNICA (Diego 10/11/2026): costo POR LOCAL. Llena insumo_costos_local con el precio de
// las compras de cada local (según la config de costeo) y recalcula todas las recetas para que
// cada una use el precio de SU local (si el local no compró ese insumo, precio_ref del grupo).
//
// - Una sola vez en toda la base (marca en lz_tareas_unicas).
// - Respaldo previo en recetas_costos_bkp_20261110c / receta_items_costos_bkp_20261110c /
//   insumos_precio_ref_bkp_20261110c, para poder volver atrás con un UPDATE … FROM.
'use strict';

const pool = require('../../config/db');
const { recalcularCostosDeNegocio } = require('../recalculoCostos');

const NOMBRE = 'costos_por_local_20261110';

async function tomarMarca() {
  await pool.query(`CREATE TABLE IF NOT EXISTS lz_tareas_unicas (
    nombre TEXT PRIMARY KEY, inicio_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    fin_at TIMESTAMPTZ, detalle JSONB)`);
  const { rows } = await pool.query(
    `INSERT INTO lz_tareas_unicas (nombre) VALUES ($1) ON CONFLICT (nombre) DO NOTHING RETURNING nombre`,
    [NOMBRE]
  );
  return rows.length > 0;
}

async function correr() {
  if (!(await tomarMarca())) return;
  console.log(`[tarea-unica] ${NOMBRE}: arranca`);
  const detalle = { negocios: {}, errores: [] };

  await pool.query(`CREATE TABLE IF NOT EXISTS recetas_costos_bkp_20261110c AS
    SELECT id, business_id, costo_total, costo_unitario, costo_total_con_merma, NOW() AS respaldado_at FROM recetas`);
  await pool.query(`CREATE TABLE IF NOT EXISTS receta_items_costos_bkp_20261110c AS
    SELECT id, receta_id, costo_unitario, NOW() AS respaldado_at FROM receta_items`);
  await pool.query(`CREATE TABLE IF NOT EXISTS insumos_precio_ref_bkp_20261110c AS
    SELECT id, business_id, precio_ref, NOW() AS respaldado_at FROM insumos`);

  const { rows } = await pool.query(`SELECT DISTINCT business_id FROM insumos WHERE business_id IS NOT NULL ORDER BY 1`);
  for (const { business_id } of rows) {
    const insBiz = Number(business_id);
    try {
      detalle.negocios[insBiz] = await recalcularCostosDeNegocio(insBiz);
      console.log(`[tarea-unica] ${NOMBRE}: negocio ${insBiz}`, JSON.stringify(detalle.negocios[insBiz]));
    } catch (e) {
      detalle.errores.push({ negocio: insBiz, error: e.message });
      console.error(`[tarea-unica] ${NOMBRE}: error negocio ${insBiz}: ${e.message}`);
    }
  }

  await pool.query(`UPDATE lz_tareas_unicas SET fin_at = NOW(), detalle = $2 WHERE nombre = $1`, [NOMBRE, detalle]);
  console.log(`[tarea-unica] ${NOMBRE}: terminada`, JSON.stringify(detalle));
}

function programar() {
  // Después del arranque (y de la tarea única anterior), sin frenarlo.
  setTimeout(() => { correr().catch((e) => console.error(`[tarea-unica] ${NOMBRE}:`, e.message)); }, 90_000).unref?.();
}

module.exports = { programar, correr };
