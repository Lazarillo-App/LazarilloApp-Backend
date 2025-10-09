// controllers/adminController.js
const db = require('../config/db');
const { logAdmin } = require('../utils/audit'); // opcional

// Helpers
const parseIntSafe = (v, d) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : d;
};

// GET /api/admin/overview
exports.overview = async (_req, res) => {
  try {
    const [{ count: total_users }]   = (await db.query(`SELECT COUNT(*)::int count FROM app_users`)).rows;
    const [{ count: active_users }]  = (await db.query(`SELECT COUNT(*)::int count FROM app_users WHERE status='active'`)).rows;
    const [{ count: total_biz }]     = (await db.query(`SELECT COUNT(*)::int count FROM app_businesses`)).rows;

    const recentUsers = (await db.query(`
      SELECT id, email, name, role, status, created_at
      FROM app_users
      ORDER BY created_at DESC
      LIMIT 5
    `)).rows;

    res.json({
      totals: { users: total_users, active_users, businesses: total_biz },
      recentUsers
    });
  } catch (e) {
    console.error('ADMIN_OVERVIEW_FAILED', e);
    res.status(500).json({ error: 'ADMIN_OVERVIEW_FAILED' });
  }
};

// GET /api/admin/users?q=&page=&pageSize=
exports.listUsers = async (req, res) => {
  try {
    const q        = (req.query.q || '').trim();
    const page     = parseIntSafe(req.query.page, 1);
    const pageSize = Math.min(parseIntSafe(req.query.pageSize, 20), 100);
    const offset   = (page - 1) * pageSize;

    const params = [];
    let where = '';
    if (q) {
      params.push(`%${q}%`, `%${q}%`);
      where = `WHERE email ILIKE $1 OR name ILIKE $2`;
    }

    const countSql = `SELECT COUNT(*)::int count FROM app_users ${where}`;
    const rowsSql  = `
      SELECT id, email, name, role, status, last_login_at, created_at
      FROM app_users
      ${where}
      ORDER BY created_at DESC
      LIMIT ${pageSize} OFFSET ${offset}
    `;

    const [{ count }] = (await db.query(countSql, params)).rows;
    const rows        = (await db.query(rowsSql, params)).rows;
    res.json({ page, pageSize, total: count, rows });
  } catch (e) {
    console.error('ADMIN_USERS_LIST_FAILED', e);
    res.status(500).json({ error: 'ADMIN_USERS_LIST_FAILED' });
  }
};

// PATCH /api/admin/users/:id
exports.updateUser = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { name, role, status } = req.body || {};

    const allowedRoles  = new Set(['admin', 'owner', 'staff', 'viewer']);
    const allowedStatus = new Set(['active', 'suspended', 'deleted']);

    if (role   != null && !allowedRoles.has(String(role)))   return res.status(400).json({ error: 'INVALID_ROLE' });
    if (status != null && !allowedStatus.has(String(status))) return res.status(400).json({ error: 'INVALID_STATUS' });

    const fields = [];
    const values = [];
    let idx = 1;

    if (name   != null) { fields.push(`name=$${idx++}`);   values.push(name); }
    if (role   != null) { fields.push(`role=$${idx++}`);   values.push(role); }
    if (status != null) { fields.push(`status=$${idx++}`); values.push(status); }

    if (!fields.length) return res.json({ ok: true });

    values.push(id);
    const sql = `
      UPDATE app_users
      SET ${fields.join(', ')}, updated_at=NOW()
      WHERE id=$${idx}
      RETURNING id, email, name, role, status
    `;
    const { rows } = await db.query(sql, values);

    Promise.resolve(
      logAdmin?.(req.user?.id || null, 'user.update', 'app_users', String(id), { name, role, status })
    ).catch(() => {});
    res.json({ ok: true, user: rows[0] });
  } catch (e) {
    console.error('ADMIN_USER_UPDATE_FAILED', e);
    res.status(500).json({ error: 'ADMIN_USER_UPDATE_FAILED' });
  }
};

// DELETE (soft) /api/admin/users/:id
exports.softDeleteUser = async (req, res) => {
  try {
    const id = Number(req.params.id);
    await db.query(`UPDATE app_users SET status='deleted', updated_at=NOW() WHERE id=$1`, [id]);
    Promise.resolve(
      logAdmin?.(req.user?.id || null, 'user.soft_delete', 'app_users', String(id))
    ).catch(() => {});
    res.json({ ok: true });
  } catch (e) {
    console.error('ADMIN_USER_DELETE_FAILED', e);
    res.status(500).json({ error: 'ADMIN_USER_DELETE_FAILED' });
  }
};

// POST /api/admin/users/:id/reset-password
// (opción: apalancamos tu flujo de reset existente seteando reset_token_* en app_users)
const crypto = require('crypto');
exports.resetPassword = async (req, res) => {
  try {
    const id = Number(req.params.id);

    const rawToken  = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

    await db.query(`
      UPDATE app_users
         SET reset_token_hash=$1,
             reset_token_expires_at=NOW() + INTERVAL '1 hour',
             updated_at=NOW()
       WHERE id=$2
    `, [tokenHash, id]);

    // Podés enviar el mail acá reutilizando utils/mailer y makeFrontUrl(...)
    // Por ahora devolvemos un preview seguro para testear desde el panel:
    res.json({ ok: true, preview_token: rawToken }); // ⚠️ solo para ambiente dev
  } catch (e) {
    console.error('ADMIN_USER_RESET_FAILED', e);
    res.status(500).json({ error: 'ADMIN_USER_RESET_FAILED' });
  }
};
