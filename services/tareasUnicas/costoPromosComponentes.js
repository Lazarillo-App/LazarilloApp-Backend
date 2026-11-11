// services/tareasUnicas/costoPromosComponentes.js
//
// Tarea ÚNICA (Diego 11/11/2026): el costo de las promos armadas con artículos guardaba el
// PRECIO DE VENTA de cada artículo (fallback de promocionesController), por eso en la tabla
// el Costo daba igual al «$ Sin Promo» (ej. Menú pizza 1285: $16.000 = ½ × $32.000 de venta,
// cuando ½ pizza cuesta $4.434). Pone una vez todos los componentes con el costo de la receta
// del artículo y recalcula el total de cada promo.
// Respaldo previo: receta_items_promos_bkp_20261111 y recetas_promos_bkp_20261111.
'use strict';

const pool = require('../../config/db');
const { actualizarComponentesDePromos } = require('../costoRecetaService');

const NOMBRE = 'costo_promos_componentes_20261111';

async function correr() {
  await pool.query(`CREATE TABLE IF NOT EXISTS lz_tareas_unicas (
    nombre TEXT PRIMARY KEY, inicio_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    fin_at TIMESTAMPTZ, detalle JSONB)`);
  const { rows: marca } = await pool.query(
    `INSERT INTO lz_tareas_unicas (nombre) VALUES ($1) ON CONFLICT (nombre) DO NOTHING RETURNING nombre`,
    [NOMBRE]
  );
  if (!marca.length) return;
  console.log(`[tarea-unica] ${NOMBRE}: arranca`);
  await pool.query(`CREATE TABLE IF NOT EXISTS receta_items_promos_bkp_20261111 AS
    SELECT ri.id, ri.receta_id, ri.costo_unitario, NOW() AS respaldado_at
      FROM receta_items ri JOIN recetas r ON r.id = ri.receta_id
     WHERE r.es_promo = TRUE AND ri.article_ref_id IS NOT NULL`);
  await pool.query(`CREATE TABLE IF NOT EXISTS recetas_promos_bkp_20261111 AS
    SELECT id, business_id, costo_total, costo_unitario, costo_total_con_merma, NOW() AS respaldado_at
      FROM recetas WHERE es_promo = TRUE`);
  let detalle;
  try { detalle = await actualizarComponentesDePromos({}); }
  catch (e) { detalle = { ok: false, error: e.message }; }
  await pool.query(`UPDATE lz_tareas_unicas SET fin_at = NOW(), detalle = $2 WHERE nombre = $1`, [NOMBRE, detalle]);
  console.log(`[tarea-unica] ${NOMBRE}: terminada`, JSON.stringify(detalle));
}

function programar() {
  // Después de las otras tareas del arranque, sin frenar el servidor.
  setTimeout(() => { correr().catch((e) => console.error(`[tarea-unica] ${NOMBRE}:`, e.message)); }, 90_000).unref?.();
}

module.exports = { programar, correr };
