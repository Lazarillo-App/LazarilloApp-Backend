// services/tareasUnicas/salidasStockInicial.js
//
// Tarea ÚNICA (Diego 17/11/2026, pendiente #109): primera carga de las salidas de stock sin venta
// (informe 27 → stock_salidas) de todos los negocios con kit, apenas arranca el servidor. Así el
// filtro de unidades Todo / Ventas / Stock tiene datos sin esperar al reloj de recetas (que solo
// corre en un servicio) ni que nadie toque «actualizar». Solo escribe stock_salidas: no toca
// ventas, compras ni costos. Después se mantiene sola en cada pasada de recetas del kit.
'use strict';

const pool = require('../../config/db');
const { PDV_MAP, refrescarPdvMap } = require('../maxiPdvMap');
const { syncSalidasStockDeNegocio } = require('../maxiPipelineStockSync');

// _b: segunda pasada después de arreglar codigo/cantidad en texto (Palermo suites daba error).
const NOMBRE = 'salidas_stock_inicial_20261117_b';

async function correr() {
  await pool.query(`CREATE TABLE IF NOT EXISTS lz_tareas_unicas (
    nombre TEXT PRIMARY KEY, inicio_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    fin_at TIMESTAMPTZ, detalle JSONB)`);
  const { rows: marca } = await pool.query(
    `INSERT INTO lz_tareas_unicas (nombre) VALUES ($1) ON CONFLICT (nombre) DO NOTHING RETURNING nombre`, [NOMBRE]);
  if (!marca.length) return;
  console.log(`[tarea-unica] ${NOMBRE}: arranca`);
  await refrescarPdvMap({ forzar: true }).catch(() => {});
  const negocios = [...new Set(Object.values(PDV_MAP).map((v) => Number(v.businessId)))];
  const detalle = {};
  for (const biz of negocios) {
    try {
      const r = await syncSalidasStockDeNegocio(biz);
      detalle[biz] = (r.porPdv || []).map((p) => ({ pdv: p.pdv, lineas: p.lineas, unidades: p.unidades }));
    } catch (e) {
      detalle[biz] = { error: e?.message || String(e) };
    }
  }
  await pool.query('UPDATE lz_tareas_unicas SET fin_at = NOW(), detalle = $2 WHERE nombre = $1', [NOMBRE, JSON.stringify(detalle)]);
  console.log(`[tarea-unica] ${NOMBRE}: listo`, JSON.stringify(detalle).slice(0, 500));
}

function programar() {
  setTimeout(() => { correr().catch((e) => console.error(`[tarea-unica] ${NOMBRE}:`, e?.message || e)); }, 45_000).unref?.();
}

module.exports = { programar, correr };
