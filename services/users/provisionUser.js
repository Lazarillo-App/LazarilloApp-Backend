// services/users/provisionUser.js
//
// Helper para el alta de usuarios desde el panel de admin. Reusa el mismo
// mecanismo de token/activación que ya usa teamController.js::createInvitation
// (columnas invitation_token_hash/invitation_expires_at, account_status='invited'),
// pero sin la parte de scopes/user_assignments — eso es específico de "invitar a
// mi equipo", no de "dar de alta una cuenta nueva" desde el admin.
//
// No manda el mail: el caller arma el asunto/html según el contexto (alta nueva
// vs reset de contraseña) y lo envía.

const crypto = require('crypto');
const pool = require('../../config/db');

const INVITATION_TTL_DAYS = 7;
const normEmail = (e = '') => String(e).trim().toLowerCase();

class EmailAlreadyActiveError extends Error {
  constructor(userId) {
    super('email_already_active');
    this.code = 'EMAIL_ALREADY_ACTIVE';
    this.userId = userId;
  }
}

/**
 * Crea (o re-invita) un usuario por email.
 * @returns {{ userId: number, isNewUser: boolean, rawToken: string, expiresAt: Date }}
 * @throws {EmailAlreadyActiveError} si el email ya pertenece a una cuenta activa
 */
async function createOrReinviteUser({ email, name, role = 'owner', invitedByUserId }) {
  const rawEmail = normEmail(email);
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000);

  const { rows: existing } = await pool.query(
    `SELECT id, account_status FROM app_users WHERE email = $1 LIMIT 1`,
    [rawEmail]
  );

  if (existing.length) {
    const row = existing[0];
    if (row.account_status !== 'invited') {
      throw new EmailAlreadyActiveError(row.id);
    }
    await pool.query(
      `UPDATE app_users
          SET invitation_token_hash = $1,
              invitation_expires_at = $2,
              invited_by_user_id    = $3
        WHERE id = $4`,
      [tokenHash, expiresAt, invitedByUserId || null, row.id]
    );
    return { userId: row.id, isNewUser: false, rawToken, expiresAt };
  }

  const { rows: inserted } = await pool.query(
    `INSERT INTO app_users
        (name, email, password_hash, account_status, role,
         invited_by_user_id, invitation_token_hash, invitation_expires_at)
     VALUES ($1, $2, NULL, 'invited', $3, $4, $5, $6)
     RETURNING id`,
    [name || null, rawEmail, role, invitedByUserId || null, tokenHash, expiresAt]
  );

  return { userId: inserted[0].id, isNewUser: true, rawToken, expiresAt };
}

module.exports = { createOrReinviteUser, EmailAlreadyActiveError, INVITATION_TTL_DAYS };
