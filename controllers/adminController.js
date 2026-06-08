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
    if (target.role === 'app_admin') return res.status(403).json({ error: 'CANNOT_DELETE_ADMIN' });

    await db.query(
      `UPDATE app_users SET status='deleted', account_status='suspended', updated_at=NOW() WHERE id=$1`,
      [id]
    );
    Promise.resolve(logAdmin(req.user?.id || null, 'user.soft_delete', 'app_users', String(id))).catch(()=>{});
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'ADMIN_USER_DELETE_FAILED' });
  }
};

// Alias para el route que lo registra como 'deleteUser'
exports.deleteUser = exports.softDeleteUser;

exports.resetPassword = async (req, res) => {
  // (si usás tokens en tabla aparte, mantené este flujo;
  // si migraste a columnas de app_users, podés eliminarlo)
  res.status(501).json({ error: 'NOT_IMPLEMENTED' });
};

// + NUEVO: restaurar usuario soft-deleted
exports.restoreUser = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { rows } = await db.query(
      `UPDATE app_users
         SET status='active', account_status='active', updated_at=NOW()
       WHERE id=$1 AND status='deleted'
       RETURNING id, email, name, role, status, account_status`,
      [id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'NOT_FOUND_OR_NOT_DELETED' });

    Promise.resolve(logAdmin(req.user?.id || null, 'user.restore', 'app_users', String(id))).catch(()=>{});

    res.json({ ok: true, user: rows[0] });
  } catch (e) {
    console.error('ADMIN_USER_RESTORE_FAILED:', e);
    res.status(500).json({ error: 'ADMIN_USER_RESTORE_FAILED' });
  }
};

// ───────────────── PEEK / AUDITORÍA ─────────────────
const pad2 = (n)=>String(n).padStart(2,'0');
const ymd = (d)=>`${d.getUTCFullYear()}-${pad2(d.getUTCMonth()+1)}-${pad2(d.getUTCDate())}`;
function parseDate(v,f){ if(!v) return new Date(f); const d=v instanceof Date?v:new Date(String(v)); return Number.isNaN(+d)?new Date(f):d; }

exports.peekVentasSummary = async (req, res) => {
  try {
    const bizId = req.businessId;
    if (!bizId) return res.status(400).json({ error: 'invalid_business' });

    const today = new Date();
    const startOfMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
    const yesterday = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 1));
    const from = ymd(parseDate(req.query.from, startOfMonth));
    const to   = ymd(parseDate(req.query.to,   yesterday));
    const limit = Math.min(Math.max(parseInt(req.query.limit || '200', 10), 1), 5000);

    const { rows } = await pool.query(
      `
      SELECT s.articulo_id,
             COALESCE(a.nombre, '(sin nombre)') AS nombre,
             SUM(s.qty)::numeric   AS qty,
             SUM(s.amount)::numeric AS amount
        FROM public.maxi_sales_daily s
   LEFT JOIN public.maxi_articles a
          ON a.business_id = s.business_id AND a.articulo_id = s.articulo_id
       WHERE s.business_id = $1
         AND s.day >= $2::date AND s.day <= $3::date
    GROUP BY s.articulo_id, a.nombre
    ORDER BY amount DESC, qty DESC
       LIMIT $4
      `,
      [bizId, from, to, limit]
    );

    res.json({ ok: true, business_id: bizId, from, to, items: rows });
  } catch (e) {
    console.error('peekVentasSummary error:', e);
    res.status(500).json({ error: 'internal', detail: e.message });
  }
};

/* ─────────────────── PEEK: Ventas series ───────────────────
   GET /admin/businesses/:id/ventas/by-article?articuloId=123&from=...&to=...&groupBy=day|week|month
*/
exports.peekVentasSeries = async (req, res) => {
  try {
    const bizId = req.businessId;
    const articuloId = Number(req.query.articuloId || req.params.articuloId);
    if (!bizId || !Number.isFinite(articuloId)) return res.status(400).json({ error: 'bad_request' });

    const today = new Date();
    const startOfMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
    const yesterday = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 1));
    const from = ymd(parseDate(req.query.from, startOfMonth));
    const to   = ymd(parseDate(req.query.to,   yesterday));
    const groupBy = ['day','week','month'].includes(String(req.query.groupBy)) ? req.query.groupBy : 'day';

    if (groupBy === 'day') {
      const { rows } = await pool.query(
        `
        SELECT day AS bucket,
               SUM(qty)::numeric AS qty,
               SUM(amount)::numeric AS amount
          FROM public.maxi_sales_daily
         WHERE business_id=$1 AND articulo_id=$2
           AND day >= $3::date AND day <= $4::date
      GROUP BY day
      ORDER BY bucket
        `,
        [bizId, articuloId, from, to]
      );
      return res.json({ ok: true, business_id: bizId, articuloId, from, to, groupBy, items: rows });
    }

    const { rows } = await pool.query(
      `
      SELECT date_trunc($5, day)::date AS bucket,
             SUM(qty)::numeric AS qty,
             SUM(amount)::numeric AS amount
        FROM public.maxi_sales_daily
       WHERE business_id=$1 AND articulo_id=$2
         AND day >= $3::date AND day <= $4::date
    GROUP BY bucket
    ORDER BY bucket
      `,
      [bizId, articuloId, from, to, groupBy]
    );
    res.json({ ok: true, business_id: bizId, articuloId, from, to, groupBy, items: rows });
  } catch (e) {
    console.error('peekVentasSeries error:', e);
    res.status(500).json({ error: 'internal', detail: e.message });
  }
};

/* ─────────────────── PEEK: Articles tree ─────────────────── */
exports.peekArticlesTree = async (req, res) => {
  try {
    const bizId = req.businessId;
    if (!bizId) return res.status(400).json({ error: 'invalid_business' });

    const { rows } = await pool.query(
      `
      SELECT articulo_id, nombre, categoria, subrubro, precio
        FROM public.maxi_articles
       WHERE business_id = $1
    ORDER BY subrubro, categoria, nombre
      `,
      [bizId]
    );

    const bySub = new Map();
    for (const r of rows) {
      const sub = r.subrubro?.trim() || 'Sin subrubro';
      const cat = r.categoria?.trim() || 'Sin categoría';
      if (!bySub.has(sub)) bySub.set(sub, new Map());
      const byCat = bySub.get(sub);
      if (!byCat.has(cat)) byCat.set(cat, []);
      byCat.get(cat).push({ id: r.articulo_id, nombre: r.nombre, precio: r.precio ?? null });
    }

    const tree = Array.from(bySub.entries()).map(([subrubro, byCat]) => ({
      subrubro,
      categorias: Array.from(byCat.entries()).map(([categoria, articulos]) => ({ categoria, articulos }))
    }));

    const resumen = {
      subrubros: tree.length,
      categorias: tree.reduce((a, s) => a + (s.categorias?.length || 0), 0),
      articulos: tree.reduce((a, s) => a + s.categorias.reduce((x, c) => x + (c.articulos?.length || 0), 0), 0),
    };

    res.json({ ok: true, business_id: bizId, resumen, tree });
  } catch (e) {
    console.error('peekArticlesTree error:', e);
    res.status(500).json({ error: 'internal', detail: e.message });
  }
};

/* ─────────────────── PEEK: Maxi status ─────────────────── */
exports.peekMaxiStatus = async (req, res) => {
  try {
    const bizId = req.businessId;
    const { rows } = await pool.query(`SELECT props FROM app_businesses WHERE id=$1 LIMIT 1`, [bizId]);
    const props = rows[0]?.props || {};
    const mx = props.maxi || props.maxi_credentials || {};
    const email = mx.email || mx.user || null;
    const codcli = mx.codcli || mx.codigo || null;
    const configured = !!(email && (mx.pass_enc || mx.password || mx.pass) && codcli);
    res.json({ ok: true, business_id: bizId, configured, email, codcli });
  } catch (e) {
    console.error('peekMaxiStatus error:', e);
    res.status(500).json({ error: 'internal', detail: e.message });
  }
};

/* ─────────────────── PEEK: Maxi menú cache ─────────────────── */
exports.peekMaxiMenuCache = async (req, res) => {
  try {
    const bizId = req.businessId;
    const { rows } = await pool.query(
      `SELECT hash, payload, updated_at
         FROM public.maxi_menu_cache
        WHERE business_id=$1
     ORDER BY updated_at DESC
        LIMIT 1`,
      [bizId]
    );
    const row = rows[0] || null;
    res.json({ ok: true, business_id: bizId, cache: row });
  } catch (e) {
    console.error('peekMaxiMenuCache error:', e);
    res.status(500).json({ error: 'internal', detail: e.message });
  }
};