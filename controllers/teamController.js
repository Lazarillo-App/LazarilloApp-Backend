// controllers/teamController.js
//
// Gestión del equipo: invitaciones, asignaciones, alias, revocaciones.
//
// Reglas:
// - Solo owner/admin del scope pueden invitar/revocar.
// - Admin solo puede invitar role='staff'. Owner puede invitar admin o staff.
// - Admin solo ve los assignments que él creó + el suyo propio.
// - Nadie puede revocar a un owner ni a sí mismo.

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const pool = require('../config/db');
const { sendEmail } = require('../utils/mailer');
const {
  getEffectiveRoleOnScope,
  ROLE_LEVEL,
} = require('../services/auth/accessControl');

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────
const FRONTEND_BASE_URL  = (process.env.FRONTEND_BASE_URL  || 'http://localhost:5173').replace(/\/+$/, '');
const FRONTEND_BASE_PATH = (process.env.FRONTEND_BASE_PATH || '').replace(/\/+$/, '');
const makeFrontUrl = (p = '') => {
  const path = `/${String(p).replace(/^\/*/, '')}`;
  return `${FRONTEND_BASE_URL}${FRONTEND_BASE_PATH}${path}`.replace(/([^:]\/)\/+/g, '$1');
};

const normEmail = (e = '') => String(e).trim().toLowerCase();

const INVITATION_TTL_DAYS = 7;

function isValidScopeType(t) {
  return t === 'business' || t === 'organization';
}

function isValidRole(r) {
  return r === 'admin' || r === 'staff';   // owner no se invita: nace por compra/creación
}

/**
 * Garantiza que el caller sea owner o admin del scope. Devuelve el rol efectivo.
 */
async function assertManagerOnScope(userId, scopeType, scopeId, res) {
  const role = await getEffectiveRoleOnScope(userId, scopeType, scopeId);
  if (!role || (ROLE_LEVEL[role] ?? 0) < ROLE_LEVEL.admin) {
    res.status(403).json({ ok: false, error: 'forbidden' });
    return null;
  }
  return role;
}

/* ════════════════════════════════════════════════════════════════════
   GET /api/team/members?scopeType=...&scopeId=...
   Lista asignaciones activas para un scope.
   - Si caller es owner: ve todos.
   - Si caller es admin: solo ve los que él creó + el suyo.
   - Si no pasás scope, devuelve todos los scopes visibles para el caller.
═════════════════════════════════════════════════════════════════════ */
exports.listMembers = async (req, res, next) => {
  try {
    const uid = req.user?.id;
    const { scopeType, scopeId } = req.query;

    if (scopeType && !isValidScopeType(scopeType)) {
      return res.status(400).json({ ok: false, error: 'invalid_scope_type' });
    }

    // Filtro por scope puntual
    if (scopeType && scopeId) {
      const callerRole = await getEffectiveRoleOnScope(uid, scopeType, Number(scopeId));
      if (!callerRole) return res.status(403).json({ ok: false, error: 'forbidden' });

      const params = [scopeType, Number(scopeId)];
      let whereCallerScope = '';
      if (callerRole === 'admin') {
        // admin solo ve los suyos + el creado por él
        params.push(uid);
        whereCallerScope = ` AND (ua.granted_by_user_id = $3 OR ua.user_id = $3)`;
      }

      const { rows } = await pool.query(
        `
        SELECT ua.id, ua.user_id, ua.scope_type, ua.scope_id,
               ua.role, ua.alias, ua.granted_by_user_id,
               ua.created_at, ua.updated_at,
               u.email, u.name, u.account_status,
               u.invitation_expires_at, u.invitation_accepted_at,
               gb.name AS granted_by_name, gb.email AS granted_by_email
          FROM user_assignments ua
          JOIN app_users u ON u.id = ua.user_id
          LEFT JOIN app_users gb ON gb.id = ua.granted_by_user_id
         WHERE ua.scope_type = $1
           AND ua.scope_id = $2
           AND ua.revoked_at IS NULL
           ${whereCallerScope}
         ORDER BY
           CASE ua.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
           ua.created_at ASC
        `,
        params
      );

      return res.json({ ok: true, members: rows });
    }

    // Sin scope: devolver agrupado por scope, solo lo que el caller puede ver
    const { rows } = await pool.query(
      `
      WITH visible_scopes AS (
        -- scopes donde soy owner/admin (por owner_id o por assignment)
        SELECT DISTINCT 'business'::text AS scope_type, b.id AS scope_id
          FROM app_businesses b
         WHERE b.owner_id = $1
        UNION
        SELECT DISTINCT ua.scope_type, ua.scope_id
          FROM user_assignments ua
         WHERE ua.user_id = $1
           AND ua.revoked_at IS NULL
           AND ua.role IN ('owner', 'admin')
      )
      SELECT ua.id, ua.user_id, ua.scope_type, ua.scope_id,
             ua.role, ua.alias, ua.granted_by_user_id,
             ua.created_at,
             u.email, u.name, u.account_status,
             u.invitation_expires_at, u.invitation_accepted_at
        FROM user_assignments ua
        JOIN app_users u ON u.id = ua.user_id
        JOIN visible_scopes vs
          ON vs.scope_type = ua.scope_type AND vs.scope_id = ua.scope_id
       WHERE ua.revoked_at IS NULL
       ORDER BY ua.scope_type, ua.scope_id, ua.created_at ASC
      `,
      [uid]
    );

    return res.json({ ok: true, members: rows });
  } catch (e) {
    console.error('[listMembers]', e);
    next(e);
  }
};

/* ════════════════════════════════════════════════════════════════════
   GET /api/team/invitations?scopeType=...&scopeId=...
   Lista invitaciones pendientes (account_status='invited' y assignment activo).
═════════════════════════════════════════════════════════════════════ */
exports.listPendingInvitations = async (req, res, next) => {
  try {
    const uid = req.user?.id;
    const { scopeType, scopeId } = req.query;

    if (!scopeType || !scopeId) {
      return res.status(400).json({ ok: false, error: 'scope_required' });
    }
    if (!isValidScopeType(scopeType)) {
      return res.status(400).json({ ok: false, error: 'invalid_scope_type' });
    }

    const callerRole = await assertManagerOnScope(uid, scopeType, Number(scopeId), res);
    if (!callerRole) return;

    const params = [scopeType, Number(scopeId)];
    let whereCallerScope = '';
    if (callerRole === 'admin') {
      params.push(uid);
      whereCallerScope = ` AND ua.granted_by_user_id = $3`;
    }

    const { rows } = await pool.query(
      `
      SELECT ua.id AS assignment_id, ua.role, ua.alias, ua.created_at,
             u.id AS user_id, u.email, u.name, u.account_status,
             u.invitation_expires_at, u.invitation_accepted_at
        FROM user_assignments ua
        JOIN app_users u ON u.id = ua.user_id
       WHERE ua.scope_type = $1
         AND ua.scope_id = $2
         AND ua.revoked_at IS NULL
         AND u.account_status = 'invited'
         ${whereCallerScope}
       ORDER BY ua.created_at DESC
      `,
      params
    );

    return res.json({ ok: true, invitations: rows });
  } catch (e) {
    console.error('[listPendingInvitations]', e);
    next(e);
  }
};

/* ════════════════════════════════════════════════════════════════════
   POST /api/team/invitations
   body: { email, scopeType, scopeId, role, alias }
═════════════════════════════════════════════════════════════════════ */
exports.createInvitation = async (req, res, next) => {
  const client = await pool.connect();
  try {
    const uid = req.user?.id;
    const { email, scopeType, scopeId, role, alias } = req.body || {};

    if (!email || !scopeType || !scopeId || !role || !alias?.trim()) {
      return res.status(400).json({ ok: false, error: 'missing_fields' });
    }
    if (!isValidScopeType(scopeType)) {
      return res.status(400).json({ ok: false, error: 'invalid_scope_type' });
    }
    if (!isValidRole(role)) {
      return res.status(400).json({ ok: false, error: 'invalid_role' });
    }

    // Autorización del caller
    const callerRole = await assertManagerOnScope(uid, scopeType, Number(scopeId), res);
    if (!callerRole) return;

    // Admin solo puede invitar staff
    if (callerRole === 'admin' && role !== 'staff') {
      return res.status(403).json({ ok: false, error: 'admin_can_only_invite_staff' });
    }

    const rawEmail = normEmail(email);
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000);

    await client.query('BEGIN');

    // ¿El email ya existe?
    const { rows: existing } = await client.query(
      `SELECT id, account_status FROM app_users WHERE email = $1 LIMIT 1`,
      [rawEmail]
    );

    let userId;
    let isNewUser = false;

    if (existing.length) {
      userId = existing[0].id;
      // Si está 'invited' aún, reseteamos su token para reenvío implícito.
      // Si está activo, no le tocamos el password — solo agregamos assignment.
      if (existing[0].account_status === 'invited') {
        await client.query(
          `UPDATE app_users
              SET invitation_token_hash = $1,
                  invitation_expires_at = $2,
                  invited_by_user_id    = $3
            WHERE id = $4`,
          [tokenHash, expiresAt, uid, userId]
        );
      }
    } else {
      isNewUser = true;
      const { rows: inserted } = await client.query(
        `INSERT INTO app_users
           (name, email, password_hash, account_status,
            invited_by_user_id, invitation_token_hash, invitation_expires_at,
            role)
         VALUES ($1, $2, NULL, 'invited', $3, $4, $5, $6)
         RETURNING id`,
        [alias.trim(), rawEmail, uid, tokenHash, expiresAt, role]
      );
      userId = inserted[0].id;
    }

    // Crear assignment (o reactivar si estaba revocado)
    const { rows: existingAssign } = await client.query(
      `SELECT id, revoked_at FROM user_assignments
        WHERE user_id = $1 AND scope_type = $2 AND scope_id = $3 AND role = $4
        LIMIT 1`,
      [userId, scopeType, Number(scopeId), role]
    );

    let assignmentId;
    if (existingAssign.length) {
      assignmentId = existingAssign[0].id;
      if (existingAssign[0].revoked_at) {
        // Reactivar
        await client.query(
          `UPDATE user_assignments
              SET revoked_at = NULL,
                  alias = $1,
                  granted_by_user_id = $2,
                  updated_at = NOW()
            WHERE id = $3`,
          [alias.trim(), uid, assignmentId]
        );
      } else {
        // Ya estaba activo: actualizar alias por las dudas
        await client.query(
          `UPDATE user_assignments
              SET alias = $1, updated_at = NOW()
            WHERE id = $2`,
          [alias.trim(), assignmentId]
        );
      }
    } else {
      const { rows: newAssign } = await client.query(
        `INSERT INTO user_assignments
           (user_id, scope_type, scope_id, role, alias, granted_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [userId, scopeType, Number(scopeId), role, alias.trim(), uid]
      );
      assignmentId = newAssign[0].id;
    }

    // Audit
    await logAudit(client, {
      userId: uid,
      businessId: scopeType === 'business' ? Number(scopeId) : null,
      organizationId: scopeType === 'organization' ? Number(scopeId) : null,
      entityType: 'team_member',
      entityId: assignmentId,
      action: 'create',
      diff: { after: { email: rawEmail, role, alias: alias.trim(), scopeType, scopeId: Number(scopeId) } },
      metadata: { is_new_user: isNewUser },
    });

    await client.query('COMMIT');

    // Enviar mail (fuera de la transacción)
    const link = makeFrontUrl(
      `/aceptar-invitacion?token=${rawToken}&email=${encodeURIComponent(rawEmail)}`
    );

    const html = isNewUser
      ? `
        <p>Hola${alias?.trim() ? ' ' + alias.trim() : ''},</p>
        <p>Fuiste invitado/a a colaborar en Lazarillo como <strong>${role === 'admin' ? 'administrador/a' : 'colaborador/a'}</strong>.</p>
        <p>Para activar tu cuenta y definir tu contraseña, abrí este enlace (válido por ${INVITATION_TTL_DAYS} días):</p>
        <p><a href="${link}">${link}</a></p>
        <p>Si no esperabas esta invitación, ignorá este mensaje.</p>
      `
      : `
        <p>Hola${alias?.trim() ? ' ' + alias.trim() : ''},</p>
        <p>Te dieron un nuevo acceso en Lazarillo como <strong>${role === 'admin' ? 'administrador/a' : 'colaborador/a'}</strong>.</p>
        <p>Iniciá sesión con tu cuenta existente para empezar a trabajar.</p>
        <p>Si no tenés acceso, podés usar este enlace para definir/restablecer tu contraseña:</p>
        <p><a href="${link}">${link}</a></p>
      `;

    let delivered = false;
    try {
      const { accepted = [] } = await sendEmail(rawEmail, 'Invitación a Lazarillo', html);
      delivered = Array.isArray(accepted) &&
        accepted.some(v => String(v).toLowerCase() === rawEmail);
    } catch (eMail) {
      console.error('[createInvitation] sendEmail failed:', eMail.message);
    }

    return res.status(201).json({
      ok: true,
      assignment_id: assignmentId,
      user_id: userId,
      is_new_user: isNewUser,
      delivered,
    });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('[createInvitation]', e);
    next(e);
  } finally {
    client.release();
  }
};

/* ════════════════════════════════════════════════════════════════════
   POST /api/team/invitations/:assignmentId/resend
═════════════════════════════════════════════════════════════════════ */
exports.resendInvitation = async (req, res, next) => {
  try {
    const uid = req.user?.id;
    const assignmentId = Number(req.params.assignmentId);
    if (!assignmentId) return res.status(400).json({ ok: false, error: 'invalid_id' });

    const { rows } = await pool.query(
      `SELECT ua.*, u.email, u.account_status
         FROM user_assignments ua
         JOIN app_users u ON u.id = ua.user_id
        WHERE ua.id = $1 LIMIT 1`,
      [assignmentId]
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: 'not_found' });

    const a = rows[0];
    const callerRole = await assertManagerOnScope(uid, a.scope_type, a.scope_id, res);
    if (!callerRole) return;

    // Admin solo puede reenviar a quienes él invitó
    if (callerRole === 'admin' && a.granted_by_user_id !== uid) {
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }

    if (a.account_status !== 'invited') {
      return res.status(409).json({ ok: false, error: 'user_already_active' });
    }

    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000);

    await pool.query(
      `UPDATE app_users
          SET invitation_token_hash = $1,
              invitation_expires_at = $2
        WHERE id = $3`,
      [tokenHash, expiresAt, a.user_id]
    );

    const link = makeFrontUrl(
      `/aceptar-invitacion?token=${rawToken}&email=${encodeURIComponent(a.email)}`
    );
    const html = `
      <p>Hola${a.alias ? ' ' + a.alias : ''},</p>
      <p>Te reenviamos la invitación a Lazarillo. Activala con este enlace (válido por ${INVITATION_TTL_DAYS} días):</p>
      <p><a href="${link}">${link}</a></p>
    `;

    let delivered = false;
    try {
      const { accepted = [] } = await sendEmail(a.email, 'Invitación a Lazarillo (reenvío)', html);
      delivered = Array.isArray(accepted) &&
        accepted.some(v => String(v).toLowerCase() === String(a.email).toLowerCase());
    } catch (eMail) {
      console.error('[resendInvitation] sendEmail failed:', eMail.message);
    }

    return res.json({ ok: true, delivered });
  } catch (e) {
    console.error('[resendInvitation]', e);
    next(e);
  }
};

/* ════════════════════════════════════════════════════════════════════
   PATCH /api/team/assignments/:assignmentId
   body: { alias?, role? }
═════════════════════════════════════════════════════════════════════ */
exports.updateAssignment = async (req, res, next) => {
  const client = await pool.connect();
  try {
    const uid = req.user?.id;
    const assignmentId = Number(req.params.assignmentId);
    const { alias, role } = req.body || {};

    if (!assignmentId) return res.status(400).json({ ok: false, error: 'invalid_id' });
    if (alias == null && role == null) {
      return res.status(400).json({ ok: false, error: 'nothing_to_update' });
    }
    if (role && !isValidRole(role) && role !== 'owner') {
      return res.status(400).json({ ok: false, error: 'invalid_role' });
    }

    const { rows } = await client.query(
      `SELECT * FROM user_assignments WHERE id = $1 LIMIT 1`,
      [assignmentId]
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: 'not_found' });
    const a = rows[0];

    const callerRole = await assertManagerOnScope(uid, a.scope_type, a.scope_id, res);
    if (!callerRole) return;

    // No se puede tocar al owner
    if (a.role === 'owner') {
      return res.status(403).json({ ok: false, error: 'cannot_modify_owner' });
    }
    // Admin solo puede tocar a quienes él creó
    if (callerRole === 'admin' && a.granted_by_user_id !== uid) {
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }
    // Admin no puede promover a admin
    if (callerRole === 'admin' && role && role !== 'staff') {
      return res.status(403).json({ ok: false, error: 'admin_cannot_change_role' });
    }

    await client.query('BEGIN');

    const sets = [];
    const params = [];
    let i = 1;
    if (alias != null) {
      sets.push(`alias = $${i++}`);
      params.push(String(alias).trim() || null);
    }
    if (role != null) {
      sets.push(`role = $${i++}`);
      params.push(role);
    }
    sets.push(`updated_at = NOW()`);
    params.push(assignmentId);

    const { rows: updated } = await client.query(
      `UPDATE user_assignments SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
      params
    );

    await logAudit(client, {
      userId: uid,
      businessId: a.scope_type === 'business' ? a.scope_id : null,
      organizationId: a.scope_type === 'organization' ? a.scope_id : null,
      entityType: 'team_member',
      entityId: assignmentId,
      action: 'update',
      diff: {
        before: { alias: a.alias, role: a.role },
        after:  { alias: updated[0].alias, role: updated[0].role },
      },
    });

    await client.query('COMMIT');
    return res.json({ ok: true, assignment: updated[0] });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('[updateAssignment]', e);
    next(e);
  } finally {
    client.release();
  }
};

/* ════════════════════════════════════════════════════════════════════
   DELETE /api/team/assignments/:assignmentId
   Soft-delete: marca revoked_at.
═════════════════════════════════════════════════════════════════════ */
exports.revokeAssignment = async (req, res, next) => {
  const client = await pool.connect();
  try {
    const uid = req.user?.id;
    const assignmentId = Number(req.params.assignmentId);
    if (!assignmentId) return res.status(400).json({ ok: false, error: 'invalid_id' });

    const { rows } = await client.query(
      `SELECT * FROM user_assignments WHERE id = $1 LIMIT 1`,
      [assignmentId]
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: 'not_found' });
    const a = rows[0];

    if (a.role === 'owner') {
      return res.status(403).json({ ok: false, error: 'cannot_revoke_owner' });
    }
    if (a.user_id === uid) {
      return res.status(403).json({ ok: false, error: 'cannot_revoke_self' });
    }

    const callerRole = await assertManagerOnScope(uid, a.scope_type, a.scope_id, res);
    if (!callerRole) return;

    if (callerRole === 'admin' && a.granted_by_user_id !== uid) {
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }

    await client.query('BEGIN');

    await client.query(
      `UPDATE user_assignments SET revoked_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [assignmentId]
    );

    await logAudit(client, {
      userId: uid,
      businessId: a.scope_type === 'business' ? a.scope_id : null,
      organizationId: a.scope_type === 'organization' ? a.scope_id : null,
      entityType: 'team_member',
      entityId: assignmentId,
      action: 'delete',
      diff: { before: { alias: a.alias, role: a.role, user_id: a.user_id } },
    });

    await client.query('COMMIT');
    return res.json({ ok: true });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('[revokeAssignment]', e);
    next(e);
  } finally {
    client.release();
  }
};

/* ════════════════════════════════════════════════════════════════════
   POST /api/auth/accept-invitation
   body: { token, email, password }
   Endpoint PÚBLICO: activa la cuenta de un invitado.
═════════════════════════════════════════════════════════════════════ */
exports.acceptInvitation = async (req, res, next) => {
  try {
    const { token = '', email = '', password = '' } = req.body || {};
    if (!token || !email || !password) {
      return res.status(400).json({ ok: false, error: 'missing_fields' });
    }
    if (password.length < 6) {
      return res.status(400).json({ ok: false, error: 'password_too_short' });
    }

    const rawEmail = normEmail(email);
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    const { rows } = await pool.query(
      `SELECT id, email, invitation_expires_at, account_status
         FROM app_users
        WHERE email = $1
          AND invitation_token_hash = $2
        LIMIT 1`,
      [rawEmail, tokenHash]
    );
    if (!rows.length) return res.status(400).json({ ok: false, error: 'invalid_token' });

    const user = rows[0];
    if (user.invitation_expires_at && new Date(user.invitation_expires_at) < new Date()) {
      return res.status(400).json({ ok: false, error: 'expired_token' });
    }

    const hash = await bcrypt.hash(password, 10);

    await pool.query(
      `UPDATE app_users
          SET password_hash         = $1,
              account_status        = 'active',
              invitation_token_hash = NULL,
              invitation_expires_at = NULL,
              invitation_accepted_at = NOW()
        WHERE id = $2`,
      [hash, user.id]
    );

    return res.json({ ok: true });
  } catch (e) {
    console.error('[acceptInvitation]', e);
    next(e);
  }
};