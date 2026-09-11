// services/auth/accessControl.js
//
// Resuelve permisos efectivos consultando user_assignments + owner_id.
// Es la fuente única de verdad para "¿este usuario puede tocar este negocio?".
//
// Reglas de acceso (en orden):
//   1) app_businesses.owner_id === userId            → role 'owner' (legacy/compat)
//   2) assignment scope='business' scope_id=bizId    → role del assignment
//   3) assignment scope='organization' scope_id=orgId del business → role del assignment (heredado)
//
// Jerarquía de roles: owner > admin > staff
// El nivel efectivo es el MÁS ALTO encontrado entre todas las fuentes.

const pool = require('../../config/db');

const ROLE_LEVEL = { owner: 3, admin: 2, staff: 1 };

function maxRole(a, b) {
  if (!a) return b;
  if (!b) return a;
  return (ROLE_LEVEL[a] ?? 0) >= (ROLE_LEVEL[b] ?? 0) ? a : b;
}

/**
 * Devuelve el rol efectivo del usuario sobre un negocio, o null si no tiene acceso.
 * @param {number} userId
 * @param {number} businessId
 * @returns {Promise<'owner'|'admin'|'staff'|null>}
 */
async function getEffectiveRole(userId, businessId) {
  if (!userId || !businessId) return null;

  const { rows } = await pool.query(
    `
    WITH biz AS (
      SELECT id, owner_id, organization_id
        FROM app_businesses
       WHERE id = $2
       LIMIT 1
    ),
    owner_role AS (
      SELECT 'owner'::text AS role
        FROM biz
       WHERE owner_id = $1
    ),
    biz_role AS (
      SELECT role
        FROM user_assignments
       WHERE user_id = $1
         AND scope_type = 'business'
         AND scope_id = $2
         AND revoked_at IS NULL
    ),
    org_role AS (
      SELECT ua.role
        FROM user_assignments ua
        JOIN biz b ON b.organization_id IS NOT NULL AND ua.scope_id = b.organization_id
       WHERE ua.user_id = $1
         AND ua.scope_type = 'organization'
         AND ua.revoked_at IS NULL
    )
    SELECT role FROM owner_role
    UNION ALL
    SELECT role FROM biz_role
    UNION ALL
    SELECT role FROM org_role
    `,
    [userId, businessId]
  );

  if (!rows.length) return null;
  return rows.map(r => r.role).reduce(maxRole, null);
}

/**
 * Verifica que el usuario tenga AL MENOS el rol requerido sobre el negocio.
 * Útil para middlewares por endpoint.
 */
async function requireRole(userId, businessId, minRole = 'staff') {
  const effective = await getEffectiveRole(userId, businessId);
  if (!effective) return { ok: false, reason: 'no_access' };
  if ((ROLE_LEVEL[effective] ?? 0) < (ROLE_LEVEL[minRole] ?? 0)) {
    return { ok: false, reason: 'insufficient_role', has: effective, need: minRole };
  }
  return { ok: true, role: effective };
}

/**
 * Devuelve TODOS los businesses accesibles para el usuario.
 * Incluye legacy (owner_id) + assignments business + assignments organization (expandidos).
 *
 * @returns {Promise<Array<{ business_id, role, source }>>}
 *   source: 'owner' | 'business' | 'organization'
 */
async function listAccessibleBusinesses(userId) {
  if (!userId) return [];

  const { rows } = await pool.query(
    `
    -- 1) Owner directo
    SELECT
      b.id AS business_id,
      'owner'::text AS role,
      'owner'::text AS source,
      NULL::text AS alias,
      NULL::bigint AS assignment_id
      FROM app_businesses b
     WHERE b.owner_id = $1

    UNION

    -- 2) Assignment directo al negocio
    SELECT
      ua.scope_id AS business_id,
      ua.role,
      'business'::text AS source,
      COALESCE(ua.self_alias, ua.alias) AS alias,
      ua.id AS assignment_id
      FROM user_assignments ua
     WHERE ua.user_id = $1
       AND ua.scope_type = 'business'
       AND ua.revoked_at IS NULL

    UNION

    -- 3) Assignment a la organización → expandido a todos sus negocios
    SELECT
      b.id AS business_id,
      ua.role,
      'organization'::text AS source,
      COALESCE(ua.self_alias, ua.alias) AS alias,
      ua.id AS assignment_id
      FROM user_assignments ua
      JOIN app_businesses b ON b.organization_id = ua.scope_id
     WHERE ua.user_id = $1
       AND ua.scope_type = 'organization'
       AND ua.revoked_at IS NULL
    `,
    [userId]
  );

  return rows;
}

/**
 * Verifica que el usuario tenga acceso al SCOPE (org o business) — usado en
 * endpoints de gestión de equipo donde el scope viene del request.
 */
async function getEffectiveRoleOnScope(userId, scopeType, scopeId) {
  if (!userId || !scopeType || !scopeId) return null;

  if (scopeType === 'business') {
    return getEffectiveRole(userId, scopeId);
  }

  if (scopeType === 'organization') {
    // Acceso a la org si: assignment org directo, o owner de algún negocio de la org
    const { rows } = await pool.query(
      `
      SELECT ua.role
        FROM user_assignments ua
       WHERE ua.user_id = $1
         AND ua.scope_type = 'organization'
         AND ua.scope_id = $2
         AND ua.revoked_at IS NULL
      UNION ALL
      SELECT 'owner'::text AS role
        FROM app_businesses
       WHERE organization_id = $2
         AND owner_id = $1
       LIMIT 1
      `,
      [userId, scopeId]
    );
    if (!rows.length) return null;
    return rows.map(r => r.role).reduce(maxRole, null);
  }

  return null;
}

/**
 * Devuelve los user_id con rol owner o admin sobre un negocio (directo +
 * heredado de la organización). Usado para notificaciones dirigidas a
 * "quien gestiona el negocio" (ej. observaciones de recetas que carga el
 * staff), no para chequeos de permisos.
 * @param {number} businessId
 * @returns {Promise<number[]>}
 */
async function listManagersForBusiness(businessId) {
  if (!businessId) return [];

  const { rows } = await pool.query(
    `
    WITH biz AS (
      SELECT id, owner_id, organization_id
        FROM app_businesses
       WHERE id = $1
       LIMIT 1
    )
    SELECT owner_id AS user_id FROM biz WHERE owner_id IS NOT NULL
    UNION
    SELECT ua.user_id
      FROM user_assignments ua
     WHERE ua.scope_type = 'business'
       AND ua.scope_id = $1
       AND ua.role IN ('owner', 'admin')
       AND ua.revoked_at IS NULL
    UNION
    SELECT ua.user_id
      FROM user_assignments ua
      JOIN biz b ON b.organization_id IS NOT NULL AND ua.scope_id = b.organization_id
     WHERE ua.scope_type = 'organization'
       AND ua.role IN ('owner', 'admin')
       AND ua.revoked_at IS NULL
    `,
    [businessId]
  );
  return rows.map(r => Number(r.user_id)).filter(n => Number.isFinite(n) && n > 0);
}

module.exports = {
  ROLE_LEVEL,
  getEffectiveRole,
  getEffectiveRoleOnScope,
  requireRole,
  listAccessibleBusinesses,
  listManagersForBusiness,
};