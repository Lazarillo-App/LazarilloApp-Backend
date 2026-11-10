// services/tareasUnicas/recalculoCostoConImpuestos.js
//
// Tarea ÚNICA (Diego 10/11/2026): el costo de los insumos pasó a tomarse con impuestos
// (neto + IVA + impuestos internos, ver precioCosteoInsumos.js). Los precio_ref ya guardados
// estaban calculados sin IVA en las facturas A: esto los recalcula todos una vez y propaga
// el costo a las recetas.
//
// - Corre una sola vez en toda la base: la marca en lz_tareas_unicas (INSERT … ON CONFLICT)
//   impide que otro arranque u otro servicio la repita.
// - Antes de tocar nada guarda un respaldo de todos los precio_ref en
//   insumos_precio_ref_bkp_20261110 (id, business_id, precio_ref, bonif_ratio, bonif_aceptada),
//   para poder volver atrás con un UPDATE … FROM.
// - Igual que el sync de compras: las compras se leen del negocio donde se registraron y el
//   precio se aplica al insumo (que puede vivir en el negocio principal). Si un insumo tiene
//   compras en varios negocios, gana el negocio con la compra más reciente.
'use strict';

const pool = require('../../config/db');
const { getModoCosteo, getConImpuestos, calcularPreciosPorModo, aplicarPreciosCosteo } = require('../precioCosteoInsumos');
const { propagarCostoInsumo } = require('../costoRecetaService');
const { recalcularBonificaciones } = require('../bonificacionesService');

const NOMBRE = 'recalculo_costo_con_impuestos_20261110';

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

  await pool.query(`CREATE TABLE IF NOT EXISTS insumos_precio_ref_bkp_20261110 AS
    SELECT id, business_id, precio_ref, bonif_ratio, bonif_aceptada, NOW() AS respaldado_at FROM insumos`);

  // Insumo (con su negocio) × negocio de la compra, con la fecha de la última compra.
  const { rows } = await pool.query(
    `SELECT i.business_id AS ins_biz, pi.business_id AS compra_biz, pi.insumo_id, MAX(pi.fecha) AS ult
       FROM purchase_items pi JOIN insumos i ON i.id = pi.insumo_id
      GROUP BY 1, 2, 3`
  );
  const porInsBiz = new Map(); // ins_biz → Map(compra_biz → [insumo_id])
  const ultima = new Map();    // `${insumo}|${compra_biz}` → fecha
  for (const r of rows) {
    const ib = Number(r.ins_biz), cb = Number(r.compra_biz), id = Number(r.insumo_id);
    if (!porInsBiz.has(ib)) porInsBiz.set(ib, new Map());
    const m = porInsBiz.get(ib);
    if (!m.has(cb)) m.set(cb, []);
    m.get(cb).push(id);
    ultima.set(`${id}|${cb}`, new Date(r.ult).getTime());
  }

  for (const [insBiz, porCompra] of porInsBiz) {
    const client = await pool.connect();
    try {
      const modo = await getModoCosteo(insBiz, client);
      if (modo === 'precio_db') continue;
      const conImpuestos = await getConImpuestos(insBiz, client);
      const elegido = new Map(); // insumo → { precio, fecha }
      for (const [compraBiz, ids] of porCompra) {
        const precios = await calcularPreciosPorModo(client, compraBiz, ids, modo, { conImpuestos });
        if (!precios) continue;
        for (const [id, precio] of precios) {
          const f = ultima.get(`${id}|${compraBiz}`) || 0;
          const prev = elegido.get(id);
          if (!prev || f > prev.fecha) elegido.set(id, { precio, fecha: f });
        }
      }
      const precios = new Map([...elegido].map(([id, v]) => [id, v.precio]));
      await client.query('BEGIN');
      const actualizados = await aplicarPreciosCosteo(client, insBiz, precios);
      for (const id of actualizados) await propagarCostoInsumo(id, insBiz, client);
      const bonif = await recalcularBonificaciones(insBiz, null, client);
      await client.query('COMMIT');
      detalle.negocios[insBiz] = { insumos: precios.size, actualizados: actualizados.length, bonificados: bonif.length };
      console.log(`[tarea-unica] ${NOMBRE}: negocio ${insBiz} → ${actualizados.length} insumos, ${bonif.length} bonificados`);
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch { /* nada */ }
      detalle.errores.push({ negocio: insBiz, error: e.message });
      console.error(`[tarea-unica] ${NOMBRE}: error negocio ${insBiz}: ${e.message}`);
    } finally {
      client.release();
    }
  }

  await pool.query(`UPDATE lz_tareas_unicas SET fin_at = NOW(), detalle = $2 WHERE nombre = $1`, [NOMBRE, detalle]);
  console.log(`[tarea-unica] ${NOMBRE}: terminada`, JSON.stringify(detalle));
}

function programar() {
  // Después del arranque, sin frenarlo.
  setTimeout(() => { correr().catch((e) => console.error(`[tarea-unica] ${NOMBRE}:`, e.message)); }, 20_000).unref?.();
}

module.exports = { programar, correr };
