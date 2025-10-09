// controllers/admin.controller.js
const db = require('../config/db');
const { logAdmin } = require('../utils/audit');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const parseIntSafe = (v, d) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : d;
};

exports.overview = async (_req, res) => {
  try {
    const [{ count: total_users }] =
      (await db.query(`SELECT COUNT(*)::int count FROM app_users`)).rows;

    const [{ count: active_users }] =
      (await db.query(`SELECT COUNT(*)::int count FROM app_users WHERE status = 'active'`)).rows;

    const [{ count: total_businesses }] =
      (await db.query(`SELECT COUNT(*)::int count FROM app_businesses`)).rows;

    const recentUsers = (await db.query(
      `SELECT id, email, COALESCE(name,'') AS name, COALESCE(role,'owner') AS role,
              status, created_at
         FROM app_users
        ORDER BY created_at DESC
        LIMIT 5`
    )).rows;

    res.json({
      totals: { users: total_users, active_users, businesses: total_businesses },
      recentUsers,
    });
  } catch (e) {
    console.error('ADMIN_OVERVIEW_FAILED:', e);
    res.status(500).json({ error: 'ADMIN_OVERVIEW_FAILED' });
  }
};

exports.listUsers = async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const page = parseIntSafe(req.query.page, 1);
    const pageSize = Math.min(parseIntSafe(req.query.pageSize, 20), 100);
    const offset = (page - 1) * pageSize;

    const params = [];
    let where = '';

    if (q) {
      params.push(`%${q}%`, `%${q}%`);
      where = `WHERE email ILIKE $1 OR COALESCE(name,'') ILIKE $2`;
    }

    const countSql = `SELECT COUNT(*)::int count FROM app_users ${where}`;
    const rowsSql = `
      SELECT id, email, COALESCE(name,'') AS name, COALESCE(role,'owner') AS role,
             status, last_login_at, created_at
        FROM app_users
        ${where}
       ORDER BY created_at DESC
       LIMIT ${pageSize} OFFSET ${offset}
    `;

    const [{ count }] = (await db.query(countSql, params)).rows;
    const rows = (await db.query(rowsSql, params)).rows;

    res.json({ page, pageSize, total: count, rows });
  } catch (e) {
    console.error('ADMIN_USERS_LIST_FAILED:', e);
    res.status(500).json({ error: 'ADMIN_USERS_LIST_FAILED' });
  }
};

exports.updateUser = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { name, role, status } = req.body || {};
    const allowedRoles = new Set(['admin', 'owner', 'staff', 'viewer']);
    const allowedStatus = new Set(['active', 'suspended', 'deleted']);

    if (role != null && !allowedRoles.has(String(role))) {
      return res.status(400).json({ error: 'INVALID_ROLE' });
    }
    if (status != null && !allowedStatus.has(String(status))) {
      return res.status(400).json({ error: 'INVALID_STATUS' });
    }

    const fields = [];
    const values = [];
    let i = 1;
    if (name != null)  { fields.push(`name=$${i++}`);  values.push(name); }
    if (role != null)  { fields.push(`role=$${i++}`);  values.push(role); }
    if (status != null){ fields.push(`status=$${i++}`);values.push(status); }
    if (!fields.length) return res.json({ ok: true });

    values.push(id);
    const { rows } = await db.query(
      `UPDATE app_users SET ${fields.join(', ')} WHERE id=$${i}
         RETURNING id, email, COALESCE(name,'') AS name, role, status`,
      values
    );

    Promise.resolve(logAdmin(req.user?.id || null, 'user.update', 'app_users', String(id), { name, role, status })).catch(()=>{});
    res.json({ ok: true, user: rows[0] });
  } catch (e) {
    console.error('ADMIN_USER_UPDATE_FAILED:', e);
    res.status(500).json({ error: 'ADMIN_USER_UPDATE_FAILED' });
  }
};

exports.softDeleteUser = async (req, res) => {
  try {
    const id = Number(req.params.id);
    await db.query(`UPDATE app_users SET status='deleted' WHERE id=$1`, [id]);
    Promise.resolve(logAdmin(req.user?.id || null, 'user.soft_delete', 'app_users', String(id))).catch(()=>{});
    res.json({ ok: true });
  } catch (e) {
    console.error('ADMIN_USER_DELETE_FAILED:', e);
    res.status(500).json({ error: 'ADMIN_USER_DELETE_FAILED' });
  }
};

exports.resetPassword = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const token = Math.random().toString(36).slice(2);
    await db.query(
      `INSERT INTO password_reset_tokens(user_id, token, expires_at)
       VALUES ($1,$2, NOW() + INTERVAL '1 day')`,
      [id, token]
    );
    Promise.resolve(logAdmin(req.user?.id || null, 'user.reset_password_token', 'app_users', String(id))).catch(()=>{});
    res.json({ ok: true, token_preview: token });
  } catch (e) {
    console.error('ADMIN_USER_RESET_FAILED:', e);
    res.status(500).json({ error: 'ADMIN_USER_RESET_FAILED' });
  }
};
