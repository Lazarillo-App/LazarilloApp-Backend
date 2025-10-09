const db = require('../config/db');
const { logAdmin } = require('../utils/audit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// Helpers de paginación
const parseIntSafe = (v, d) => {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : d;
};

exports.login = async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) {
        return res.status(400).json({ error: 'EMAIL_AND_PASSWORD_REQUIRED' });
    }
    const { rows } = await db.query(
        `SELECT id, email, name, role, status, password_hash FROM users WHERE email=$1 LIMIT 1`,
        [email]
    );
    const user = rows[0];
    if (!user || user.status !== 'active') {
        return res.status(401).json({ error: 'INVALID_CREDENTIALS' });
    }
    const ok = await bcrypt.compare(password, user.password_hash || '');
    if (!ok) return res.status(401).json({ error: 'INVALID_CREDENTIALS' });
    if (!process.env.JWT_SECRET) {
        console.error('[auth] JWT_SECRET no definido');
        return res.status(500).json({ error: 'SERVER_MISCONFIGURED' });
    }

    // incluye role en el JWT para que el front pueda decidir
    const token = jwt.sign(
        { uid: user.id, role: user.role },
        process.env.JWT_SECRET,
        { expiresIn: '12h' }
    );

    res.json({
        token,
        user: { id: user.id, email: user.email, name: user.name, role: user.role }
    });
};

exports.overview = async (req, res) => {
    try {
        const [{ count: total_users }] = (await db.query(`SELECT COUNT(*)::int count FROM users`)).rows;
        const [{ count: active_users }] = (await db.query(
            `SELECT COUNT(*)::int count FROM users WHERE status='active'`
        )).rows;
        const [{ count: total_businesses }] = (await db.query(
            `SELECT COUNT(*)::int count FROM businesses`
        )).rows;

        // Últimos registros creados (mini feed)
        const recentUsers = (await db.query(
            `SELECT id, email, name, role, status, created_at
       FROM users ORDER BY created_at DESC LIMIT 5`
        )).rows;

        res.json({
            totals: {
                users: total_users,
                active_users,
                businesses: total_businesses
            },
            recentUsers
        });
    } catch (e) {
        console.error(e);
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
            params.push(`%${q}%`);
            // En Postgres, ILIKE hace case-insensitive nativo
            where = `WHERE email ILIKE $${params.length} OR name ILIKE $${params.length}`;
        }
        const countSql = `SELECT COUNT(*)::int count FROM users ${where}`;
        const rowsSql = `
      SELECT id, email, name, role, status, last_login_at, created_at
      FROM users
      ${where}
      ORDER BY created_at DESC
      LIMIT ${pageSize} OFFSET ${offset}
    `;

        const [{ count }] = (await db.query(countSql, params)).rows;
        const rows = (await db.query(rowsSql, params)).rows;
        res.json({ page, pageSize, total: count, rows });
    } catch (e) {
        console.error(e);
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
        let idx = 1;

        if (name != null) { fields.push(`name=$${idx++}`); values.push(name); }
        if (role != null) { fields.push(`role=$${idx++}`); values.push(role); }
        if (status != null) { fields.push(`status=$${idx++}`); values.push(status); }

        if (!fields.length) return res.json({ ok: true });

        values.push(id);
        const sql = `UPDATE users SET ${fields.join(', ')} WHERE id=$${idx} RETURNING id, email, name, role, status`;
        const { rows } = await db.query(sql, values);

        Promise.resolve(
            logAdmin(req.user?.id || null, 'user.update', 'users', String(id), { name, role, status })
        ).catch(() => { });
        res.json({ ok: true, user: rows[0] });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'ADMIN_USER_UPDATE_FAILED' });
    }
};

exports.softDeleteUser = async (req, res) => {
    try {
        const id = Number(req.params.id);
        await db.query(`UPDATE users SET status='deleted' WHERE id=$1`, [id]);
        Promise.resolve(
            logAdmin(req.user?.id || null, 'user.soft_delete', 'users', String(id))
        ).catch(() => { });
        res.json({ ok: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'ADMIN_USER_DELETE_FAILED' });
    }
};

exports.resetPassword = async (req, res) => {
    try {
        const id = Number(req.params.id);
        // Generar token de un solo uso (placeholder) y guardarlo
        const token = Math.random().toString(36).slice(2);
        await db.query(
            `INSERT INTO password_reset_tokens(user_id, token, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '1 day')`,
            [id, token]
        );
        Promise.resolve(
            logAdmin(req.user?.id || null, 'user.reset_password_token', 'users', String(id))
        ).catch(() => { });
        // Envía email con tu servicio real; aquí devolvemos el token para integrar luego
        res.json({ ok: true, token_preview: token });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'ADMIN_USER_RESET_FAILED' });
    }
};
