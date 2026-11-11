// services/tareasUnicas/recalculoDesperdicio.js
//
// Tarea ÚNICA (11/11/2026): hasta hoy, cambiar el desperdicio global en Configuración no
// recalculaba las recetas (FC pasó de 2% a 1% y la tabla seguía con el costo viejo). Desde
// ahora el cambio dispara el recálculo (businessController.update); esto pone al día una vez
// las recetas de todos los negocios con el desperdicio que tienen guardado.
// Una sola vez en toda la base: marca en lz_tareas_unicas.
'use strict';

const pool = require('../../config/db');
const { recalcularRecetasDeNegocio } = require('../costoRecetaService');

const NOMBRE = 'recalculo_desperdicio_20261111';

async function correr() {
  await pool.query(`CREATE TABLE IF NOT EXISTS lz_tareas_unicas (
    nombre TEXT PRIMARY KEY, inicio_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    fin_at TIMESTAMPTZ, detalle JSONB)`);
  const { rows: marca } = await pool.query(
    `INSERT INTO lz_tareas_unicas (nombre) VALUES ($1) ON CONFLICT (nombre) DO NOTHING RETURNING nombre`,
    [NOMBRE]
  );
  if (!marca.length) return;
  const { rows } = await pool.query(
    `SELECT DISTINCT business_id FROM recetas WHERE active = TRUE ORDER BY business_id`
  );
  const detalle = {};
  for (const r of rows) {
    try { detalle[r.business_id] = await recalcularRecetasDeNegocio(r.business_id); }
    catch (e) { detalle[r.business_id] = { ok: false, error: e.message }; }
  }
  await pool.query(`UPDATE lz_tareas_unicas SET fin_at = NOW(), detalle = $2 WHERE nombre = $1`, [NOMBRE, detalle]);
  console.log(`[tarea-unica] ${NOMBRE}: terminada`, JSON.stringify(detalle));
}

function programar() {
  // Después de la otra tarea única del arranque, sin frenar el servidor.
  setTimeout(() => { correr().catch((e) => console.error(`[tarea-unica] ${NOMBRE}:`, e.message)); }, 60_000).unref?.();
}

module.exports = { programar, correr };
