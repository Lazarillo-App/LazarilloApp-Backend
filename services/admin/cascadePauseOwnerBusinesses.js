// services/admin/cascadePauseOwnerBusinesses.js
//
// Pausa en cascada todos los negocios de un dueño (owner_id) cuando su cuenta
// se suspende o se elimina — nunca se pierde nada, solo queda bloqueado el uso
// normal (ver middleware/authMiddleware.js::loadActiveBusiness) hasta que se
// despause a mano desde el admin.

const pool = require('../../config/db');
const { logAudit } = require('../audit/auditLog');

/**
 * @param {object} client - pool o client de transacción
 * @param {object} params
 * @param {number} params.ownerUserId
 * @param {number} [params.adminId] - quién ejecuta la acción (para auditoría)
 * @param {string} params.reason - 'owner_suspended' | 'owner_deleted'
 * @returns {Promise<Array<{id:number, name:string}>>} negocios pausados
 */
async function pauseOwnedBusinesses(client, { ownerUserId, adminId, reason }) {
  const db = client || pool;

  const { rows } = await db.query(
    `UPDATE app_businesses
        SET paused_at = NOW(),
            paused_reason = $1,
            paused_by = $2,
            paused_by_cascade = true
      WHERE owner_id = $3 AND paused_at IS NULL
      RETURNING id, name`,
    [reason, adminId || null, ownerUserId]
  );

  for (const biz of rows) {
    await logAudit(db, {
      userId: adminId || null,
      businessId: biz.id,
      entityType: 'business',
      entityId: biz.id,
      action: 'update',
      diff: { after: { paused_at: 'now', paused_reason: reason, paused_by_cascade: true } },
      metadata: { reason, owner_user_id: ownerUserId },
    });
  }

  return rows;
}

module.exports = { pauseOwnedBusinesses };
