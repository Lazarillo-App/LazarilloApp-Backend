// controllers/authController.js
const pool = require('../config/db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET || 'dev-secret';

function signToken(user) {
  return jwt.sign({ uid: user.id, email: user.email }, SECRET, { expiresIn: '7d' });
}

exports.register = async (req, res) => {
  try {
    const { name = '', email = '', password = '' } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'email_and_password_required' });
    }

    // Chequeo case-insensitive
    const { rows: ex } = await pool.query(
      'SELECT 1 FROM app_users WHERE lower(email)=lower($1) LIMIT 1',
      [email]
    );
    if (ex[0]) return res.status(409).json({ error: 'email_in_use' });

    const hash = await bcrypt.hash(password, 10);

    // Si luego agregás "phone" a la tabla, añadí ", phone" y el cuarto valor
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
    // Si luego agregás "phone", podés armar un UPDATE dinámico o añadirlo aquí.
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
