// controllers/admin/adminUsersController.js
const db = require('../../config/db');
const crypto = require('crypto');
const { logAudit } = require('../../services/audit/auditLog');
const { sendEmail } = require('../../utils/mailer');
const { createOrReinviteUser, EmailAlreadyActiveError, INVITATION_TTL_DAYS } = require('../../services/users/provisionUser');
const { pauseOwnedBusinesses } = require('../../services/admin/cascadePauseOwnerBusinesses');

const FRONTEND_BASE_URL = (process.env.FRONTEND_BASE_URL || 'http://localhost:5173').replace(/\/+$/, '');
const FRONTEND_BASE_PATH = (process.env.FRONTEND_BASE_PATH || '').replace(/\/+$/, '');
const makeFrontUrl = (p = '') => {
  const path = `/${String(p).replace(/^\/*/, '')}`;
  return `${FRONTEND_BASE_URL}${FRONTEND_BASE_PATH}${path}`.replace(/([^:]\/)\/+/g, '$1');
};

exports.overview = async (_req, res) => {
  try {
    const [{ count: total_users }] =
      (await db.query(`SELECT COUNT(*)::int count FROM app_users`)).rows;
    const [{ count: active_users }] =
      (await db.query(`SELECT COUNT(*)::int count FROM app_users WHERE account_status IN ('active','trial')`)).rows;
    const [{ count: pending_users }] =
      (await db.query(`SELECT COUNT(*)::int count FROM app_users WHERE account_status = 'pending'`)).rows;
    const [{ count: expired_users }] =
      (await db.query(`SELECT COUNT(*)::int count FROM app_users WHERE account_status = 'expired'`)).rows;
    const [{ count: total_businesses }] =
      (await db.query(`SELECT COUNT(*)::int count FROM app_businesses`)).rows;

    const recentUsers = (await db.query(
      `SELECT id, email, COALESCE(name,'') AS name, COALESCE(role,'owner') AS role,
              status, account_status, created_at
         FROM app_users
        ORDER BY created_at DESC
        LIMIT 5`
    )).rows;

    res.json({
      totals: {
        users: total_users,
        active_users,
        pending_users,
        expired_users,
        businesses: total_businesses,
      },
      recentUsers,
    });
  } catch (e) {
    console.error('ADMIN_OVERVIEW_FAILED:', e);
    res.status(500).json({ error: 'ADMIN_OVERVIEW_FAILED' });
  }
};

exports.getUser = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { rows } = await db.query(
      `SELECT id, name, email, role, status, account_status,
              trial_ends_at, subscription_ends_at, activated_at, phone, created_at
         FROM app_users WHERE id = $1 LIMIT 1`,
      [id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'NOT_FOUND' });
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'internal' });
  }
};

exports.listUsers = async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize || '20', 10), 1), 100);
    const offset = (page - 1) * pageSize;

    const params = [];
    let where = '';
    if (q) {
      params.push(`%${q}%`, `%${q}%`);
      where = `WHERE email ILIKE $1 OR COALESCE(name,'') ILIKE $2`;
    }

    const [{ count }] = (await db.query(
      `SELECT COUNT(*)::int count FROM app_users ${where}`, params
    )).rows;

    const rows = (await db.query(
      `SELECT id, email, COALESCE(name,'') AS name, COALESCE(role,'owner') AS role,
              status, account_status, trial_ends_at, subscription_ends_at, created_at
         FROM app_users
        ${where}
        ORDER BY created_at DESC
        LIMIT ${pageSize} OFFSET ${offset}`,
      params
    )).rows;

    res.json({ page, pageSize, total: count, rows });
  } catch (e) {
    console.error('ADMIN_USERS_LIST_FAILED:', e);
    res.status(500).json({ error: 'ADMIN_USERS_LIST_FAILED' });
  }
};

exports.updateUser = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { name, role, status, email } = req.body || {};

    const { rows } = await db.query(
      `SELECT id, role, email FROM app_users WHERE id=$1 LIMIT 1`, [id]
    );
    const target = rows[0];
    if (!target) return res.status(404).json({ error: 'NOT_FOUND' });

    if (email && email !== target.email) {
      const { rows: clash } = await db.query(
        `SELECT 1 FROM app_users WHERE lower(email)=lower($1) AND id<>$2 LIMIT 1`,
        [email, id]
      );
      if (clash[0]) return res.status(409).json({ error: 'EMAIL_IN_USE' });
    }

    const fields = [];
    const values = [];
    let i = 1;

    if (name  != null) { fields.push(`name=$${i++}`);  values.push(name); }
    if (email != null) { fields.push(`email=$${i++}`); values.push(email); }

    if (target.role !== 'app_admin') {
      const allowedRoles  = new Set(['owner', 'staff', 'viewer']);
      // 'suspended' se saca de acá: no bloqueaba el login (esa función real la
      // tiene account_status, vía /api/access/admin/users/:id/suspend). Los
      // cambios de status pasan por los endpoints dedicados (soft-delete/restore).
      const allowedStatus = new Set(['active', 'deleted']);
      if (role   != null) {
        if (!allowedRoles.has(String(role)))  return res.status(400).json({ error: 'INVALID_ROLE' });
        fields.push(`role=$${i++}`);  values.push(role);
      }
      if (status != null) {
        if (!allowedStatus.has(String(status))) return res.status(400).json({ error: 'INVALID_STATUS' });
        fields.push(`status=$${i++}`); values.push(status);
      }
    } else {
      if (role != null || status != null) {
        return res.status(403).json({ error: 'CANNOT_MODIFY_ADMIN_ROLE_OR_STATUS' });
      }
    }

    if (!fields.length) return res.json({ ok: true });

    const before = target;
    values.push(id);
    const sql = `UPDATE app_users SET ${fields.join(', ')} WHERE id=$${i}
                 RETURNING id, email, name, role, status`;
    const up = await db.query(sql, values);

    await logAudit(null, {
      userId: req.user?.id || null,
      entityType: 'app_user',
      entityId: id,
      action: 'update',
      diff: { before: { email: before.email }, after: up.rows[0] },
    });

    res.json({ ok: true, user: up.rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'ADMIN_USER_UPDATE_FAILED' });
  }
};

exports.softDeleteUser = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const confirm = req.query.confirm === '1' || req.body?.confirm === true;

    const { rows } = await db.query(
      `SELECT id, role FROM app_users WHERE id=$1 LIMIT 1`, [id]
    );
    const target = rows[0];
    if (!target) return res.status(404).json({ error: 'NOT_FOUND' });
    if (target.role === 'app_admin') return res.status(403).json({ error: 'CANNOT_DELETE_ADMIN' });

    // Borrado seguro: si el usuario todavía es dueño de negocios sin pausar,
    // se pide confirmación explícita antes de eliminar (se van a pausar, nunca
    // se borran ni se destruyen).
    const { rows: activeBiz } = await db.query(
      `SELECT id, name FROM app_businesses WHERE owner_id = $1 AND paused_at IS NULL`,
      [id]
    );
    if (activeBiz.length && !confirm) {
      return res.status(409).json({
        error: 'HAS_ACTIVE_BUSINESSES',
        businesses: activeBiz,
      });
    }

    await db.query(
      `UPDATE app_users SET status='deleted', account_status='suspended', updated_at=NOW() WHERE id=$1`,
      [id]
    );

    const pausedBusinesses = await pauseOwnedBusinesses(db, {
      ownerUserId: id, adminId: req.user?.id || null, reason: 'owner_deleted',
    });

    await logAudit(null, {
      userId: req.user?.id || null,
      entityType: 'app_user',
      entityId: id,
      action: 'delete',
    });

    res.json({ ok: true, paused_businesses: pausedBusinesses });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'ADMIN_USER_DELETE_FAILED' });
  }
};

// Alias para el route que lo registra como 'deleteUser'
exports.deleteUser = exports.softDeleteUser;

// + NUEVO: restaurar usuario soft-deleted
exports.restoreUser = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { rows } = await db.query(
      `UPDATE app_users
         SET status='active', account_status='active', updated_at=NOW()
       WHERE id=$1 AND status='deleted'
       RETURNING id, email, name, role, status, account_status`,
      [id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'NOT_FOUND_OR_NOT_DELETED' });

    await logAudit(null, {
      userId: req.user?.id || null,
      entityType: 'app_user',
      entityId: id,
      action: 'restore',
    });

    res.json({ ok: true, user: rows[0] });
  } catch (e) {
    console.error('ADMIN_USER_RESTORE_FAILED:', e);
    res.status(500).json({ error: 'ADMIN_USER_RESTORE_FAILED' });
  }
};

/**
 * POST /admin/users
 * body: { email, name, role? }
 * Da de alta una cuenta nueva (o reenvía la invitación si ya existía como
 * 'invited'). Reusa el mismo mecanismo de token que teamController.createInvitation,
 * pero sin asignarle ningún scope: nace como cuenta suelta, sin negocio.
 */
exports.createUser = async (req, res) => {
  try {
    const { email, name, role } = req.body || {};
    if (!email) return res.status(400).json({ error: 'email_required' });

    const allowedRoles = new Set(['owner', 'staff', 'viewer']);
    const effRole = role && allowedRoles.has(String(role)) ? role : 'owner';

    let result;
    try {
      result = await createOrReinviteUser({
        email, name, role: effRole, invitedByUserId: req.user?.id || null,
      });
    } catch (e) {
      if (e instanceof EmailAlreadyActiveError) {
        return res.status(409).json({ error: 'EMAIL_IN_USE' });
      }
      throw e;
    }

    const link = makeFrontUrl(
      `/aceptar-invitacion?token=${result.rawToken}&email=${encodeURIComponent(String(email).trim().toLowerCase())}`
    );
    const html = `
      <p>Hola${name ? ' ' + name : ''},</p>
      <p>Se creó una cuenta para vos en Lazarillo.</p>
      <p>Para activarla y definir tu contraseña, abrí este enlace (válido por ${INVITATION_TTL_DAYS} días):</p>
      <p><a href="${link}">${link}</a></p>
    `;

    let delivered = false;
    try {
      const { accepted = [], simulated } = await sendEmail(email, 'Tu cuenta en Lazarillo', html);
      delivered = !simulated && Array.isArray(accepted) &&
        accepted.some(v => String(v).toLowerCase() === String(email).trim().toLowerCase());
    } catch (eMail) {
      console.error('[adminCreateUser] sendEmail failed:', eMail.message);
    }

    await logAudit(null, {
      userId: req.user?.id || null,
      entityType: 'app_user',
      entityId: result.userId,
      action: 'create',
      diff: { after: { email, name, role: effRole } },
      metadata: { is_new_user: result.isNewUser, source: 'admin_panel' },
    });

    res.status(201).json({
      ok: true,
      user_id: result.userId,
      is_new_user: result.isNewUser,
      delivered,
      link,
    });
  } catch (e) {
    console.error('ADMIN_CREATE_USER_FAILED:', e);
    res.status(500).json({ error: 'ADMIN_CREATE_USER_FAILED' });
  }
};

/**
 * POST /admin/users/:id/reset-password
 * Dispara el mismo flujo de "olvidé mi contraseña" (authController), en vez de
 * inventar una contraseña temporal — así el admin nunca necesita conocerla.
 */
exports.resetPassword = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { rows } = await db.query(`SELECT id, email FROM app_users WHERE id=$1 LIMIT 1`, [id]);
    const user = rows[0];
    if (!user) return res.status(404).json({ error: 'NOT_FOUND' });

    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1h, mismo TTL que el flujo normal

    await db.query(
      `UPDATE app_users SET reset_token_hash=$1, reset_token_expires_at=$2 WHERE id=$3`,
      [tokenHash, expiresAt, id]
    );

    const link = makeFrontUrl(`/reset-password?token=${rawToken}&email=${encodeURIComponent(user.email)}`);
    const html = `
      <p>Un administrador de Lazarillo inició un restablecimiento de contraseña para tu cuenta.</p>
      <p>Usá este enlace (válido por 1 hora):</p>
      <p><a href="${link}">${link}</a></p>
      <p>Si no esperabas esto, ignorá este email.</p>
    `;

    let delivered = false;
    try {
      const { accepted = [], simulated } = await sendEmail(user.email, 'Restablecer contraseña', html);
      delivered = !simulated && Array.isArray(accepted) &&
        accepted.some(v => String(v).toLowerCase() === String(user.email).toLowerCase());
    } catch (eMail) {
      console.error('[adminResetPassword] sendEmail failed:', eMail.message);
    }

    await logAudit(null, {
      userId: req.user?.id || null,
      entityType: 'app_user',
      entityId: id,
      action: 'update',
      metadata: { reason: 'admin_reset_password' },
    });

    res.json({ ok: true, delivered, link });
  } catch (e) {
    console.error('ADMIN_RESET_PASSWORD_FAILED:', e);
    res.status(500).json({ error: 'ADMIN_RESET_PASSWORD_FAILED' });
  }
};

/**
 * GET /admin/users/:id/businesses
 * Negocios accesibles por el usuario: dueño directo, asignación de negocio,
 * o asignación heredada de organización.
 */
exports.userBusinesses = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { rows } = await db.query(
      `
      SELECT DISTINCT b.id, b.name, b.slug, b.organization_id, o.name AS organization_name,
             (b.owner_id = $1) AS is_owner
        FROM app_businesses b
        LEFT JOIN organizations o ON o.id = b.organization_id
       WHERE b.owner_id = $1
          OR EXISTS (
            SELECT 1 FROM user_assignments ua
             WHERE ua.user_id = $1 AND ua.revoked_at IS NULL
               AND ua.scope_type = 'business' AND ua.scope_id = b.id
          )
          OR (
            b.organization_id IS NOT NULL AND EXISTS (
              SELECT 1 FROM user_assignments ua
               WHERE ua.user_id = $1 AND ua.revoked_at IS NULL
                 AND ua.scope_type = 'organization' AND ua.scope_id = b.organization_id
            )
          )
       ORDER BY b.name
      `,
      [id]
    );
    res.json({ ok: true, businesses: rows });
  } catch (e) {
    console.error('ADMIN_USER_BUSINESSES_FAILED:', e);
    res.status(500).json({ error: 'internal' });
  }
};

/**
 * GET /admin/users/:id/activity
 * Historial desde audit_log: acciones sobre este usuario, o hechas por él.
 */
exports.userActivity = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { rows } = await db.query(
      `SELECT id, business_id, organization_id, user_id, user_alias_snapshot,
              entity_type, entity_id, action, diff, metadata, created_at
         FROM audit_log
        WHERE user_id = $1
           OR (entity_type = 'app_user' AND entity_id = $2)
        ORDER BY created_at DESC
        LIMIT 50`,
      [id, String(id)]
    );
    res.json({ ok: true, activity: rows });
  } catch (e) {
    console.error('ADMIN_USER_ACTIVITY_FAILED:', e);
    res.status(500).json({ error: 'internal' });
  }
};
