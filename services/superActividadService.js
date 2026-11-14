// services/superActividadService.js
// Avisos del panel de super usuarios (usuaria 13/11/2026): cada acción del panel queda registrada
// y sale en la solapa "Admins" de la campana. Lo propio se ve pero no cuenta como nuevo.
'use strict';

const pool = require('../config/db');

const corto = (s, max) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** Registra una acción. Nunca corta lo que se estaba haciendo: si falla, solo lo anota en el log. */
async function registrar(actorId, tipo, accion, { titulo, detalle, tarea_id, pedido_id } = {}) {
  try {
    await pool.query(
      `INSERT INTO super_actividad (actor_id, tipo, accion, titulo, detalle, tarea_id, pedido_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [Number(actorId) || null, tipo, corto(accion, 200), corto(titulo, 200) || null, corto(detalle, 300) || null,
        Number(tarea_id) || null, Number(pedido_id) || null]);
  } catch (e) {
    console.error('[superActividad] no se pudo registrar:', e.message);
  }
}

/** Últimas acciones, con cuántas son nuevas para este usuario (de otros, después de su "visto"). */
async function listar(userId, limite = 50) {
  const lim = Math.min(Math.max(Number(limite) || 50, 1), 200);
  const { rows: v } = await pool.query('SELECT visto_hasta FROM super_actividad_visto WHERE user_id = $1', [userId]);
  const visto = v[0]?.visto_hasta || null;
  const { rows } = await pool.query(
    `SELECT a.id, a.actor_id, a.tipo, a.accion, a.titulo, a.detalle, a.tarea_id, a.pedido_id, a.created_at,
            coalesce(u.display_name, u.name, u.email) AS actor
       FROM super_actividad a LEFT JOIN app_users u ON u.id = a.actor_id
      ORDER BY a.created_at DESC LIMIT $1`, [lim]);
  const { rows: n } = await pool.query(
    `SELECT COUNT(*)::int n FROM super_actividad
      WHERE actor_id IS DISTINCT FROM $1 AND ($2::timestamptz IS NULL OR created_at > $2)
        AND created_at > now() - interval '30 days'`, [userId, visto]);
  return { actividad: rows, nuevos: n[0].n, visto_hasta: visto };
}

async function marcarVisto(userId) {
  await pool.query(
    `INSERT INTO super_actividad_visto (user_id, visto_hasta) VALUES ($1, now())
     ON CONFLICT (user_id) DO UPDATE SET visto_hasta = now()`, [userId]);
  return { ok: true };
}

module.exports = { registrar, listar, marcarVisto };
