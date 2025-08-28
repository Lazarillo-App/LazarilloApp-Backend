const pool = require('../config/db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

function signToken(user) {
  return jwt.sign({ uid: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '7d' });
}

exports.register = async (req, res) => {
  try {
    const { name, email, password, phone } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email_and_password_required' });

    const { rows: ex } = await pool.query('SELECT 1 FROM app_users WHERE email=$1', [email]);
    if (ex[0]) return res.status(409).json({ error: 'email_in_use' });

    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      'INSERT INTO app_users (name,email,password_hash,phone) VALUES ($1,$2,$3,$4) RETURNING id,name,email,phone,active_business_id',
      [name || null, email, hash, phone || null]
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
    const { email, password } = req.body;
    const { rows } = await pool.query('SELECT * FROM app_users WHERE email=$1', [email]);
    const user = rows[0];
    if (!user) return res.status(401).json({ error: 'invalid_credentials' });
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'invalid_credentials' });
    const token = signToken(user);
    res.json({
      token,
      user: {
        id: user.id, name: user.name, email: user.email, phone: user.phone,
        active_business_id: user.active_business_id
      }
    });
  } catch (e) {
    console.error('login error:', e);
    res.status(500).json({ error: 'internal' });
  }
};

exports.me = async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id,name,email,phone,active_business_id FROM app_users WHERE id=$1',
    [req.user.id]
  );
  res.json(rows[0]);
};

exports.updateMe = async (req, res) => {
  const { name, phone } = req.body;
  const { rows } = await pool.query(
    'UPDATE app_users SET name=$1, phone=$2, updated_at=now() WHERE id=$3 RETURNING id,name,email,phone,active_business_id',
    [name || null, phone || null, req.user.id]
  );
  res.json(rows[0]);
};
