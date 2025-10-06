// controllers/authController.js
const pool = require('../config/db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { sendEmail } = require('../utils/mailer');

const SECRET = process.env.JWT_SECRET || 'dev-secret';

// <<< URL helper para el frontend (soporta prefijo /LazarilloApp en gh-pages) >>>
const FRONTEND_BASE_URL = (process.env.FRONTEND_BASE_URL || 'http://localhost:5173').replace(/\/+$/, '');
const FRONTEND_BASE_PATH = (process.env.FRONTEND_BASE_PATH || '').replace(/\/+$/, '');
const makeFrontUrl = (p) =>
  `${FRONTEND_BASE_URL}${FRONTEND_BASE_PATH}${p}`.replace(/([^:]\/)\/+/g, '$1');
// Ejemplos:
// local:  http://localhost:5173 + ''          + /reset-password?token=... -> http://localhost:5173/reset-password?token=...
// ghpages:https://lazarillo-app.github.io + /LazarilloApp + /reset-password?token=... -> https://lazarillo-app.github.io/LazarilloApp/reset-password?token=...

function signToken(user) {
  return jwt.sign({ uid: user.id, email: user.email }, SECRET, { expiresIn: '7d' });
}

exports.register = async (req, res) => {
  try {
    const { name = '', email = '', password = '' } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'email_and_password_required' });
    }

    const { rows: ex } = await pool.query(
      'SELECT 1 FROM app_users WHERE lower(email)=lower($1) LIMIT 1',
      [email]
    );
    if (ex[0]) return res.status(409).json({ error: 'email_in_use' });

    const hash = await bcrypt.hash(password, 10);

    const { rows } = await pool.query(
      'INSERT INTO app_users (name, email, password_hash) VALUES ($1,$2,$3) RETURNING id, name, email, active_business_id',
      [name || null, email.trim(), hash]
    );

    const user = rows[0];
    const token = signToken(user);
    res.status(201).json({ token, user });
  } catch (e) {
    console.error('register error:', e);
    res.status(500).json({ error: 'internal' });
  }
};

exports.login = async (req, res) => {
  try {
    const { email = '', password = '' } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'email_and_password_required' });
    }

    const { rows } = await pool.query(
      'SELECT id, name, email, password_hash, active_business_id FROM app_users WHERE lower(email)=lower($1) LIMIT 1',
      [email]
    );
    const user = rows[0];
    if (!user) return res.status(401).json({ error: 'invalid_credentials' });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'invalid_credentials' });

    const token = signToken(user);
    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        active_business_id: user.active_business_id || null,
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
      'SELECT id, name, email, active_business_id FROM app_users WHERE id=$1',
      [req.user.id]
    );
    res.json(rows[0] || null);
  } catch (e) {
    console.error('me error:', e);
    res.status(500).json({ error: 'internal' });
  }
};

exports.updateMe = async (req, res) => {
  try {
    const { name = null } = req.body || {};
    const { rows } = await pool.query(
      'UPDATE app_users SET name=$1 WHERE id=$2 RETURNING id, name, email, active_business_id',
      [name, req.user.id]
    );
    res.json(rows[0] || null);
  } catch (e) {
    console.error('updateMe error:', e);
    res.status(500).json({ error: 'internal' });
  }
};

// backend/src/controllers/authController.js
exports.requestPasswordReset = async (req, res) => {
  try {
    const { email = '' } = req.body || {};
    if (!email) return res.status(400).json({ error: 'email_required' });

    const { rows } = await pool.query(
      'SELECT id, email FROM app_users WHERE lower(email)=lower($1) LIMIT 1',
      [email]
    );

    // No revelar existencia: misma respuesta, pero con flags técnicos neutros
    if (!rows[0]) return res.json({ ok: true, delivered: true, accepted: [], rejected: [] });

    const user = rows[0];
    const rawToken  = crypto.randomBytes(32).toString('hex');
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
    const delivered = Array.isArray(accepted) && accepted.includes(user.email);

    // Nota: mantenemos 200 y ok:true. Agregamos flags diagnósticos.
    return res.json({ ok: true, delivered, accepted, rejected });
  } catch (e) {
    console.error('requestPasswordReset error:', e);
    // no filtramos: ok:true pero marcamos delivered=false
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
