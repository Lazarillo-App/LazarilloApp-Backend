// controllers/authController.js
const pool = require('../config/db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { sendEmail } = require('../utils/mailer');

const SECRET = process.env.JWT_SECRET || 'dev-secret';

// ===== Helpers =========================================================
const normEmail = (e = '') => String(e).trim().toLowerCase();

// URL helper para el frontend (soporta prefijo /LazarilloApp en gh-pages)
const FRONTEND_BASE_URL = (process.env.FRONTEND_BASE_URL || 'http://localhost:5173').replace(/\/+$/, '');
const FRONTEND_BASE_PATH = (process.env.FRONTEND_BASE_PATH || '').replace(/\/+$/, '');
const makeFrontUrl = (p = '') => {
  const path = `/${String(p).replace(/^\/*/, '')}`; // asegura único slash adelante
  return `${FRONTEND_BASE_URL}${FRONTEND_BASE_PATH}${path}`.replace(/([^:]\/)\/+/g, '$1');
};

// Firmado de JWT con iss/aud (puede validarse luego en el middleware)
function signToken(user) {
  const opts = { expiresIn: '7d', issuer: 'lazarillo-api', audience: 'lazarillo-web' };
  // Solo incluimos role si es app_admin (rol de plataforma).
  // Los roles de negocio se resuelven con /api/me/access.
  const payload = { uid: user.id, email: user.email };
  if (user.role === 'app_admin') payload.role = 'app_admin';
  return jwt.sign(payload, SECRET, opts);
}

/* ===================== OPCIONAL: rate-limit simple de login ===================== */
// Muy simple, en memoria. Activar si querés proteger de bruteforce sin Redis.
// const loginHits = new Map(); // ip -> { count, ts }
// const HIT_WINDOW_MS = 60_000;
// const HIT_MAX = 20;
// function tooMany(req) {
//   const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
//           || req.socket?.remoteAddress || 'unknown';
//   const now = Date.now();
//   const rec = loginHits.get(ip) || { count: 0, ts: now };
//   if (now - rec.ts > HIT_WINDOW_MS) { rec.count = 0; rec.ts = now; }
//   rec.count++;
//   loginHits.set(ip, rec);
//   return rec.count > HIT_MAX;
// }

/* ================================================================================ */

exports.register = async (req, res) => {
  try {
    const { name = '', email = '', password = '' } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'email_and_password_required' });
    }

    const rawEmail = normEmail(email);

    const { rows: ex } = await pool.query(
      'SELECT 1 FROM app_users WHERE email=$1 LIMIT 1',
      [rawEmail]
    );
    if (ex[0]) return res.status(409).json({ error: 'email_in_use' });

    const hash = await bcrypt.hash(password, 10);

    const { rows } = await pool.query(
      `INSERT INTO app_users (name, email, password_hash, account_status, role)
       VALUES ($1,$2,$3,'pending','owner')
       RETURNING id, name, email, active_business_id, role, status, account_status`,
      [name || null, rawEmail, hash]
    );

    const user = rows[0];
    // user.role ya viene 'owner' del INSERT — no sobreescribir

    const token = signToken(user);

    res.status(201).json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        active_business_id: user.active_business_id || null,
        role: user.role === 'app_admin' ? 'app_admin' : null,
        account_status: 'pending',
      },
    });
  } catch (e) {
    console.error('register error:', e);
    res.status(500).json({ error: 'internal' });
  }
};

exports.login = async (req, res) => {
  try {
    // if (tooMany(req)) return res.status(429).json({ error: 'too_many_attempts' }); // (OPCIONAL)

    const { email = '', password = '' } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'email_and_password_required' });
    }

    const rawEmail = normEmail(email);

    const { rows } = await pool.query(
      `SELECT id, name, email, password_hash, active_business_id, role, status,
              account_status, trial_ends_at, subscription_ends_at
         FROM app_users WHERE email=$1 LIMIT 1`,
      [rawEmail]
    );
    const user = rows[0];
    // Solo bloquear si el usuario no existe o está suspendido explícitamente
    if (!user) return res.status(401).json({ error: 'invalid_credentials' });
    if (user.account_status === 'suspended') {
      return res.status(403).json({ error: 'account_suspended' });
    }

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'invalid_credentials' });

    // Auto-vencer si el tiempo expiró
    let accountStatus = user.account_status || 'pending';
    const now = new Date();
    if (accountStatus === 'trial' && user.trial_ends_at && new Date(user.trial_ends_at) < now) {
      accountStatus = 'expired';
      await pool.query(
        `UPDATE app_users SET account_status = 'expired', updated_at = NOW() WHERE id = $1`,
        [user.id]
      ).catch(() => {});
    }
    if (accountStatus === 'active' && user.subscription_ends_at && new Date(user.subscription_ends_at) < now) {
      accountStatus = 'expired';
      await pool.query(
        `UPDATE app_users SET account_status = 'expired', updated_at = NOW() WHERE id = $1`,
        [user.id]
      ).catch(() => {});
    }

    const token = signToken(user);

    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        active_business_id: user.active_business_id || null,
        role: user.role === 'app_admin' ? 'app_admin' : null,
        account_status: accountStatus,
        trial_ends_at: user.trial_ends_at || null,
        subscription_ends_at: user.subscription_ends_at || null,
      },
    });
  } catch (e) {
    console.error('login error:', e);
    res.status(500).json({ error: 'internal' });
  }
};

exports.me = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, email, active_business_id, role, status,
              account_status, trial_ends_at, subscription_ends_at
         FROM app_users WHERE id=$1`,
      [req.user.id]
    );
    res.json(rows[0] || null);
  } catch (e) {
    res.status(500).json({ error: 'internal' });
  }
};

exports.updateMe = async (req, res) => {
  try {
    const body = req.body || {};
    const sets = [];
    const vals = [];
    let pi = 1;

    if (body.name !== undefined) {
      sets.push(`name = $${pi++}`);
      vals.push(body.name || null);
    }
    if (body.displayName !== undefined) {
      sets.push(`display_name = $${pi++}`);
      vals.push(String(body.displayName || '').trim() || null);
    }

    if (!sets.length) {
      return res.json({ ok: true, message: 'Sin cambios' });
    }

    vals.push(req.user.id);
    const { rows } = await pool.query(
      `UPDATE app_users SET ${sets.join(', ')}, updated_at = NOW()
        WHERE id = $${pi}
       RETURNING id, name, display_name, email, active_business_id, role, status`,
      vals
    );
    res.json(rows[0] || null);
  } catch (e) {
    console.error('[updateMe]', e.message);
    res.status(500).json({ error: 'internal' });
  }
};

exports.requestPasswordReset = async (req, res) => {
  try {
    const { email = '' } = req.body || {};
    if (!email) return res.status(400).json({ error: 'email_required' });

    const rawEmail = normEmail(email);

    const { rows } = await pool.query(
      'SELECT id, email FROM app_users WHERE email=$1 LIMIT 1',
      [rawEmail]
    );

    // Respuesta neutra para no revelar existencia
    if (!rows[0]) return res.json({ ok: true, delivered: true, accepted: [], rejected: [] });

    const user = rows[0];
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 h

    await pool.query(
      'UPDATE app_users SET reset_token_hash=$1, reset_token_expires_at=$2 WHERE id=$3',
      [tokenHash, expiresAt, user.id]
    );

    const link = makeFrontUrl(`/reset-password?token=${rawToken}&email=${encodeURIComponent(user.email)}`);
    const html = `
      <p>Pediste restablecer tu contraseña en Lazarillo.</p>
      <p>Usá este enlace (válido por 1 hora):</p>
      <p><a href="${link}">${link}</a></p>
      <p>Si no fuiste vos, ignorá este email.</p>
    `;

    const { accepted = [], rejected = [] } = await sendEmail(user.email, 'Restablecer contraseña', html);
    const delivered =
      Array.isArray(accepted) &&
      accepted.some(v => String(v).toLowerCase() === String(user.email).toLowerCase());

    return res.json({ ok: true, delivered, accepted, rejected });
  } catch (e) {
    console.error('requestPasswordReset error:', e);
    // No filtrar error: devolvemos ok:true pero delivered=false para UX consistente
    return res.json({ ok: true, delivered: false, accepted: [], rejected: [] });
  }
};

exports.resetPassword = async (req, res) => {
  try {
    const { token = '', password = '' } = req.body || {};
    if (!token || !password) return res.status(400).json({ error: 'token_and_password_required' });

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const { rows } = await pool.query(
      `SELECT id FROM app_users
       WHERE reset_token_hash=$1 AND reset_token_expires_at > NOW()
       LIMIT 1`,
      [tokenHash]
    );
    if (!rows[0]) return res.status(400).json({ error: 'invalid_or_expired_token' });

    const userId = rows[0].id;
    const hash = await bcrypt.hash(password, 10);

    await pool.query(
      `UPDATE app_users
         SET password_hash=$1, reset_token_hash=NULL, reset_token_expires_at=NULL
       WHERE id=$2`,
      [hash, userId]
    );

    return res.json({ ok: true });
  } catch (e) {
    console.error('resetPassword error:', e);
    return res.status(500).json({ error: 'internal' });
  }
};

