// services/recetaObservaciones.js
//
// Hilo de observaciones de una receta (producto o elaborado). A diferencia del
// viejo campo único `recetas.notas` (se pisaba), acá cada observación queda
// como una fila con autor y fecha — y dispara una notificación a owner/admin
// del negocio (salvo al propio autor), para que se enteren cuando el staff
// deja una observación sobre una receta.
'use strict';

const pool = require('../config/db');
const { logAudit } = require('./audit/auditLog');
const { createSyncNotification } = require('./notificationService');
const { listManagersForBusiness } = require('./auth/accessControl');

async function listObservaciones(recetaId) {
  const { rows } = await pool.query(
    `SELECT id, user_id, autor_alias_snapshot, texto, created_at
       FROM receta_observaciones
      WHERE receta_id = $1
      ORDER BY created_at ASC, id ASC`,
    [recetaId]
  );
  return rows;
}

/**
 * @param {object} params
 * @param {number} params.recetaId
 * @param {number} params.businessId
 * @param {number} params.userId
 * @param {string} params.texto
 * @param {string} [params.entityType] - 'receta' | 'receta_elaborado' (para el historial de actividad)
 * @param {number} [params.entityId]   - article_id o insumo_id (para el historial de actividad)
 */
async function addObservacion({ recetaId, businessId, userId, texto, entityType, entityId }) {
  const limpio = String(texto || '').trim();
  if (!limpio) throw new Error('texto_requerido');

  const { rows: userRows } = await pool.query(
    `SELECT COALESCE(NULLIF(name,''), email) AS alias FROM app_users WHERE id = $1`,
    [userId]
  );
  const alias = userRows[0]?.alias || null;

  const { rows } = await pool.query(
    `INSERT INTO receta_observaciones (receta_id, business_id, user_id, autor_alias_snapshot, texto)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, user_id, autor_alias_snapshot, texto, created_at`,
    [recetaId, businessId, userId, alias, limpio]
  );
  const observacion = rows[0];

  if (entityType && entityId != null) {
    await logAudit(null, {
      userId, businessId,
      entityType, entityId,
      action: 'update',
      diff: { after: { observacion: limpio } },
      metadata: { tipo: 'observacion', observacionId: observacion.id },
    });
  }

  // Notificar a owner/admin del negocio, excepto al propio autor — no debe
  // romper el guardado de la observación si falla.
  try {
    const managers = await listManagersForBusiness(businessId);
    const destinatarios = managers.filter(uid => Number(uid) !== Number(userId));
    for (const uid of destinatarios) {
      await createSyncNotification({
        businessId,
        userId: uid,
        type: 'receta_observacion',
        title: `Nueva observación de ${alias || 'un integrante del equipo'}`,
        message: limpio.length > 140 ? `${limpio.slice(0, 140)}…` : limpio,
        metadata: { recetaId, entityType, entityId, autorUserId: userId },
      });
    }
  } catch (e) {
    console.warn('[recetaObservaciones] no se pudo notificar:', e.message);
  }

  return observacion;
}

module.exports = { listObservaciones, addObservacion };
