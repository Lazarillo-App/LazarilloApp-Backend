// controllers/accessController.js
'use strict';

const pool   = require('../config/db');
const crypto = require('crypto');
const { pauseOwnedBusinesses } = require('../services/admin/cascadePauseOwnerBusinesses');

// ── helpers ───────────────────────────────────────────────────────────────────

function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function generateCode(prefix = 'LAZ') {
  const rand = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `${prefix}-${rand}`;
}

// ── Leer account_status actualizado ──────────────────────────────────────────

async function getAccountStatus(userId) {
  const { rows } = await pool.query(
    `SELECT account_status, trial_ends_at, subscription_ends_at
       FROM app_users WHERE id = $1 LIMIT 1`,
    [userId]
  );
  if (!rows[0]) return null;

  const u = rows[0];
  const now = new Date();

  // Auto-vencer si el tiempo expiró
  if (u.account_status === 'trial' && u.trial_ends_at && new Date(u.trial_ends_at) < now) {
    await pool.query(
      `UPDATE app_users SET account_status = 'expired', updated_at = NOW() WHERE id = $1`,
      [userId]
    );
    return 'expired';
  }
  if (u.account_status === 'active' && u.subscription_ends_at && new Date(u.subscription_ends_at) < now) {
    await pool.query(
      `UPDATE app_users SET account_status = 'expired', updated_at = NOW() WHERE id = $1`,
      [userId]
    );
    return 'expired';
  }

  return u.account_status;
}

// ── POST /api/access/redeem — canjear cupón ───────────────────────────────────

exports.redeemCode = async (req, res) => {
  const userId = req.user?.id;
  const { code } = req.body || {};

  if (!code) return res.status(400).json({ ok: false, error: 'code_required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Buscar cupón válido
    const { rows: codeRows } = await client.query(
      `SELECT * FROM access_codes
        WHERE code = $1
          AND active = TRUE
          AND (expires_at IS NULL OR expires_at > NOW())
          AND uses_count < max_uses
        FOR UPDATE`,
      [String(code).trim().toUpperCase()]
    );

    if (!codeRows[0]) {
      await client.query('ROLLBACK');
      return res.status(400).json({ ok: false, error: 'invalid_or_expired_code' });
    }

    const ac = codeRows[0];

    // Verificar que el usuario no lo canjeó antes
    const { rows: prevRows } = await client.query(
      `SELECT 1 FROM access_code_redemptions WHERE code_id = $1 AND user_id = $2`,
      [ac.id, userId]
    );
    if (prevRows[0]) {
      await client.query('ROLLBACK');
      return res.status(400).json({ ok: false, error: 'code_already_used' });
    }

    // Calcular fecha de vencimiento
    const now = new Date();
    const grantedUntil = ac.duration_days ? addDays(now, ac.duration_days) : null;

    // Actualizar estado del usuario
    const newStatus = ac.type === 'full' ? 'active' : 'trial';
    if (newStatus === 'trial') {
      await client.query(
        `UPDATE app_users
            SET account_status   = 'trial',
                trial_ends_at    = $2,
                activated_at     = NOW(),
                activated_by     = NULL,
                updated_at       = NOW()
          WHERE id = $1`,
        [userId, grantedUntil]
      );
    } else {
      await client.query(
        `UPDATE app_users
            SET account_status        = 'active',
                subscription_ends_at  = $2,
                activated_at          = NOW(),
                activated_by          = NULL,
                updated_at            = NOW()
          WHERE id = $1`,
        [userId, grantedUntil]
      );
    }

    // Registrar canje
    await client.query(
      `INSERT INTO access_code_redemptions (code_id, user_id, granted_until)
       VALUES ($1, $2, $3)`,
      [ac.id, userId, grantedUntil]
    );

    // Incrementar contador de usos
    await client.query(
      `UPDATE access_codes SET uses_count = uses_count + 1 WHERE id = $1`,
      [ac.id]
    );

    // Auditoría
    await client.query(
      `INSERT INTO account_activations (user_id, action, code_id, valid_until, notes)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, newStatus === 'active' ? 'activate_full' : 'activate_trial', ac.id, grantedUntil,
       `Cupón canjeado: ${ac.code}`]
    );

    await client.query('COMMIT');

    return res.json({
      ok: true,
      account_status: newStatus,
      granted_until: grantedUntil,
      type: ac.type,
    });

  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { }
    console.error('[redeemCode]', e);
    return res.status(500).json({ ok: false, error: 'internal' });
  } finally {
    client.release();
  }
};

// ── GET /api/access/status — estado actual de la cuenta ──────────────────────

exports.getStatus = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { rows } = await pool.query(
      `SELECT account_status, trial_ends_at, subscription_ends_at, activated_at
         FROM app_users WHERE id = $1 LIMIT 1`,
      [userId]
    );
    if (!rows[0]) return res.status(404).json({ ok: false, error: 'user_not_found' });

    const status = await getAccountStatus(userId);
    const u = rows[0];

    return res.json({
      ok: true,
      account_status: status,
      trial_ends_at: u.trial_ends_at || null,
      subscription_ends_at: u.subscription_ends_at || null,
      activated_at: u.activated_at || null,
    });
  } catch (e) {
    console.error('[getStatus]', e);
    return res.status(500).json({ ok: false, error: 'internal' });
  }
};

// ── ADMIN: POST /api/admin/access/codes — crear cupón ────────────────────────

exports.createCode = async (req, res) => {
  try {
    const adminId = req.user?.id;
    const { type = 'trial', duration_days, max_uses = 1, notes, expires_at, prefix } = req.body || {};

    if (!['trial', 'full'].includes(type)) {
      return res.status(400).json({ ok: false, error: 'invalid_type' });
    }

    const code = generateCode(prefix || 'LAZ');

    const { rows } = await pool.query(
      `INSERT INTO access_codes (code, type, duration_days, max_uses, created_by, notes, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [code, type, duration_days || null, max_uses, adminId, notes || null, expires_at || null]
    );

    return res.status(201).json({ ok: true, code: rows[0] });
  } catch (e) {
    console.error('[createCode]', e);
    return res.status(500).json({ ok: false, error: 'internal' });
  }
};

// ── ADMIN: GET /api/admin/access/codes — listar cupones ──────────────────────

exports.listCodes = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT ac.*,
              u.name AS created_by_name, u.email AS created_by_email
         FROM access_codes ac
         LEFT JOIN app_users u ON u.id = ac.created_by
        ORDER BY ac.created_at DESC`
    );
    return res.json({ ok: true, codes: rows });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'internal' });
  }
};

// ── ADMIN: DELETE /api/admin/access/codes/:id — desactivar cupón ─────────────

exports.deactivateCode = async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query(
      `UPDATE access_codes SET active = FALSE WHERE id = $1`,
      [id]
    );
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'internal' });
  }
};

// ── ADMIN: GET /api/admin/access/users — listar usuarios con estado ───────────

exports.listUsers = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.name, u.email, u.role, u.created_at,
              u.account_status, u.trial_ends_at, u.subscription_ends_at, u.activated_at,
              ab.name AS activated_by_name
         FROM app_users u
         LEFT JOIN app_users ab ON ab.id = u.activated_by
        ORDER BY u.created_at DESC`
    );
    return res.json({ ok: true, users: rows });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'internal' });
  }
};

// ── ADMIN: POST /api/admin/access/users/:id/activate — activar manualmente ───

exports.activateUser = async (req, res) => {
  const client = await pool.connect();
  try {
    const adminId = req.user?.id;
    const userId = Number(req.params.id);
    const { type = 'trial', duration_days, notes } = req.body || {};

    if (!Number.isFinite(userId)) {
      return res.status(400).json({ ok: false, error: 'invalid_user_id' });
    }

    await client.query('BEGIN');

    const now = new Date();
    const validUntil = duration_days ? addDays(now, duration_days) : null;
    const newStatus = type === 'full' ? 'active' : 'trial';

    if (newStatus === 'trial') {
      await client.query(
        `UPDATE app_users
            SET account_status = 'trial',
                trial_ends_at  = $2,
                activated_at   = NOW(),
                activated_by   = $3,
                updated_at     = NOW()
          WHERE id = $1`,
        [userId, validUntil, adminId]
      );
    } else {
      await client.query(
        `UPDATE app_users
            SET account_status       = 'active',
                subscription_ends_at = $2,
                activated_at         = NOW(),
                activated_by         = $3,
                updated_at           = NOW()
          WHERE id = $1`,
        [userId, validUntil, adminId]
      );
    }

    await client.query(
      `INSERT INTO account_activations (user_id, action, performed_by, valid_until, notes)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, newStatus === 'active' ? 'activate_full' : 'activate_trial',
       adminId, validUntil, notes || null]
    );

    await client.query('COMMIT');

    return res.json({ ok: true, account_status: newStatus, valid_until: validUntil });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { }
    console.error('[activateUser]', e);
    return res.status(500).json({ ok: false, error: 'internal' });
  } finally {
    client.release();
  }
};

// ── ADMIN: POST /api/admin/access/users/:id/suspend ──────────────────────────

exports.suspendUser = async (req, res) => {
  try {
    const adminId = req.user?.id;
    const userId = Number(req.params.id);
    const { notes } = req.body || {};

    await pool.query(
      `UPDATE app_users
          SET account_status = 'suspended', updated_at = NOW()
        WHERE id = $1`,
      [userId]
    );

    await pool.query(
      `INSERT INTO account_activations (user_id, action, performed_by, notes)
       VALUES ($1, 'suspend', $2, $3)`,
      [userId, adminId, notes || null]
    );

    // Suspender la cuenta pausa en cascada los negocios que posee — sin perder
    // nada, solo bloqueando el uso normal hasta que se despausen a mano.
    const pausedBusinesses = await pauseOwnedBusinesses(pool, {
      ownerUserId: userId, adminId, reason: 'owner_suspended',
    });

    return res.json({ ok: true, paused_businesses: pausedBusinesses });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'internal' });
  }
};

module.exports = exports;