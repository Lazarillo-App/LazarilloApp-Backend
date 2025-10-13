// controllers/admincontroller.js
const db = require('../config/db');
const { logAdmin } = require('../utils/audit');

const parseIntSafe = (v, d) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : d;
};

exports.overview = async (_req, res) => {
  try {
    const [{ count: total_users }] =
      (await db.query(`SELECT COUNT(*)::int count FROM app_users`)).rows;
    const [{ count: active_users }] =
      (await db.query(`SELECT COUNT(*)::int count FROM app_users WHERE status='active'`)).rows;
    const [{ count: total_businesses }] =
      (await db.query(`SELECT COUNT(*)::int count FROM app_businesses`)).rows;

    const recentUsers = (await db.query(
      `SELECT id, email, COALESCE(name,'') AS name, COALESCE(role,'owner') AS role,
              status, created_at
         FROM app_users
        ORDER BY created_at DESC
        LIMIT 5`
    )).rows;

    res.json({ totals: { users: total_users, active_users, businesses: total_businesses }, recentUsers });
  } catch (e) {
    console.error('ADMIN_OVERVIEW_FAILED:', e);
    res.status(500).json({ error: 'ADMIN_OVERVIEW_FAILED' });
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
              status, created_at
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

    if (target.role !== 'admin') {
      const allowedRoles  = new Set(['admin','owner','staff','viewer']);
      const allowedStatus = new Set(['active','suspended','deleted']);
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

    values.push(id);
    const sql = `UPDATE app_users SET ${fields.join(', ')} WHERE id=$${i}
                 RETURNING id, email, name, role, status`;
    const up = await db.query(sql, values);

    Promise.resolve(
      logAdmin(req.user?.id || null, 'user.update', 'app_users', String(id),
               { name, email, role: target.role==='admin' ? undefined : role,
                 status: target.role==='admin' ? undefined : status })
    ).catch(()=>{});

    res.json({ ok: true, user: up.rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'ADMIN_USER_UPDATE_FAILED' });
  }
};

exports.softDeleteUser = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { rows } = await db.query(
      `SELECT id, role FROM app_users WHERE id=$1 LIMIT 1`, [id]
    );
    const target = rows[0];
    if (!target) return res.status(404).json({ error: 'NOT_FOUND' });
    if (target.role === 'admin') return res.status(403).json({ error: 'CANNOT_DELETE_ADMIN' });

    await db.query(`UPDATE app_users SET status='deleted' WHERE id=$1`, [id]);
    Promise.resolve(logAdmin(req.user?.id || null, 'user.soft_delete', 'app_users', String(id))).catch(()=>{});
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'ADMIN_USER_DELETE_FAILED' });
  }
};

exports.resetPassword = async (req, res) => {
  // (si usás tokens en tabla aparte, mantené este flujo;
  // si migraste a columnas de app_users, podés eliminarlo)
  res.status(501).json({ error: 'NOT_IMPLEMENTED' });
};
