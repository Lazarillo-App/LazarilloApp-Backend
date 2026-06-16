// services/audit/auditLog.js
//
// Helper único para registrar cambios en audit_log.
// Llamalo desde controllers de create/update/delete después de un éxito.
//
// Uso típico:
//   const { logAudit, computeDiff } = require('../services/audit/auditLog');
//
//   // Update:
//   const before = await getArticulo(id);
//   await updateArticulo(...);
//   const after = await getArticulo(id);
//   await logAudit(client, {
//     userId: req.user.id,
//     businessId,
//     entityType: 'articulo',
//     entityId: id,
//     action: 'update',
//     diff: computeDiff(before, after, ['nombre','precio','categoria']),
//   });
//
// `client` puede ser el pool o un client de transacción.
// Si pasás null/undefined, usa el pool por default.

const pool = require('../../config/db');

const ALLOWED_ACTIONS = new Set(['create', 'update', 'delete', 'restore', 'reassign']);

/**
 * Calcula un diff campo a campo entre `before` y `after`.
 * Si no pasás `fields`, compara todas las keys presentes en alguno de los dos.
 *
 * @param {object|null} before
 * @param {object|null} after
 * @param {string[]} [fields]
 * @returns {{ before: object, after: object }}
 */
function computeDiff(before, after, fields = null) {
  const b = before || {};
  const a = after || {};
  const keys = fields || Array.from(new Set([...Object.keys(b), ...Object.keys(a)]));

  const beforeOut = {};
  const afterOut = {};

  for (const k of keys) {
    const bv = b[k];
    const av = a[k];
    if (JSON.stringify(bv) !== JSON.stringify(av)) {
      beforeOut[k] = bv ?? null;
      afterOut[k] = av ?? null;
    }
  }

  return { before: beforeOut, after: afterOut };
}

/**
 * Resuelve el alias del usuario en el scope del businessId.
 * Prioridad: assignment business > assignment organization > app_users.name > email.
 */
async function resolveUserAlias(client, userId, businessId) {
  if (!userId) return null;
  const db = client || pool;

  try {
    const { rows } = await db.query(
      `
      WITH biz AS (
        SELECT organization_id FROM app_businesses WHERE id = $2 LIMIT 1
      )
      SELECT alias FROM user_assignments
       WHERE user_id = $1 AND scope_type = 'business' AND scope_id = $2 AND revoked_at IS NULL
      UNION ALL
      SELECT alias FROM user_assignments ua
        JOIN biz ON biz.organization_id IS NOT NULL AND ua.scope_id = biz.organization_id
       WHERE ua.user_id = $1 AND ua.scope_type = 'organization' AND ua.revoked_at IS NULL
      LIMIT 1
      `,
      [userId, businessId]
    );
    if (rows[0]?.alias) return rows[0].alias;

    // Fallback: name o email
    const { rows: u } = await db.query(
      `SELECT COALESCE(NULLIF(name,''), email) AS alias FROM app_users WHERE id = $1`,
      [userId]
    );
    return u[0]?.alias || null;
  } catch (e) {
    console.warn('[auditLog] resolveUserAlias error:', e.message);
    return null;
  }
}

/**
 * Inserta una fila en audit_log. No tira si falla (logging no debe romper la operación).
 *
 * @param {object|null} client  - pool client (transacción) o null/pool
 * @param {object} params
 * @param {number} params.userId
 * @param {number} [params.businessId]
 * @param {number} [params.organizationId]    - si no se pasa, se resuelve a partir del business
 * @param {string} params.entityType          - 'articulo' | 'insumo' | 'receta' | ...
 * @param {string|number} params.entityId
 * @param {'create'|'update'|'delete'|'restore'|'reassign'} params.action
 * @param {object} [params.diff]              - { before, after } o lo que necesites
 * @param {object} [params.metadata]
 * @param {string} [params.userAliasSnapshot] - si lo pasás, se usa tal cual; si no, se resuelve
 */
async function logAudit(client, params) {
  const db = client || pool;

  try {
    const {
      userId = null,
      businessId = null,
      organizationId = null,
      entityType,
      entityId,
      action,
      diff = {},
      metadata = {},
      userAliasSnapshot = null,
    } = params || {};

    if (!entityType || entityId == null || !action) {
      console.warn('[auditLog] skip: missing required fields', { entityType, entityId, action });
      return;
    }
    if (!ALLOWED_ACTIONS.has(action)) {
      console.warn('[auditLog] skip: invalid action', action);
      return;
    }

    // Resolver organization_id si no vino
    let orgId = organizationId;
    if (!orgId && businessId) {
      const { rows } = await db.query(
        `SELECT organization_id FROM app_businesses WHERE id = $1 LIMIT 1`,
        [businessId]
      );
      orgId = rows[0]?.organization_id || null;
    }

    // Resolver alias snapshot
    const alias = userAliasSnapshot != null
      ? userAliasSnapshot
      : await resolveUserAlias(db, userId, businessId);

    await db.query(
      `INSERT INTO audit_log
         (business_id, organization_id, user_id, user_alias_snapshot,
          entity_type, entity_id, action, diff, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb)`,
      [
        businessId,
        orgId,
        userId,
        alias,
        entityType,
        String(entityId),
        action,
        JSON.stringify(diff || {}),
        JSON.stringify(metadata || {}),
      ]
    );
  } catch (e) {
    // No propagamos: el logging no debe romper la operación de negocio
    console.error('[auditLog] insert failed:', e.message);
  }
}

module.exports = {
  logAudit,
  computeDiff,
  resolveUserAlias,
};
