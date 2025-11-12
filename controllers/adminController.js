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

// + NUEVO: restaurar usuario soft-deleted
exports.restoreUser = async (req, res) => {
  try {
    const id = Number(req.params.id);
    // Solo restaura si estaba deleted
    const { rows } = await db.query(
      `UPDATE app_users
         SET status='active'
       WHERE id=$1 AND status='deleted'
       RETURNING id, email, name, role, status`,
      [id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'NOT_FOUND_OR_NOT_DELETED' });

    // auditar opcional
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

exports.peekVentasSummary = async (req,res)=>{
  const businessId = req.businessId;
  if (!businessId) return res.status(400).json({ error:'no_business' });

  const today = new Date();
  const startOfMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const yesterday    = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()-1));

  const from = ymd(parseDate(req.query.from, startOfMonth));
  const to   = ymd(parseDate(req.query.to,   yesterday));

  const { rows } = await db.query(`
    SELECT articulo_id,
           SUM(qty)::numeric   AS qty,
           SUM(amount)::numeric AS amount
    FROM public.maxi_sales_daily
    WHERE business_id=$1
      AND day BETWEEN $2 AND $3
    GROUP BY articulo_id
    ORDER BY amount DESC, qty DESC
  `,[businessId, from, to]);

  res.json({ ok:true, business_id: businessId, from, to, items: rows });
};

exports.peekVentasSeries = async (req,res)=>{
  const businessId = req.businessId;
  const articuloId = Number(req.query.articuloId || req.params.articuloId);
  let groupBy = String(req.query.groupBy || 'day');
  if (!['day','week','month'].includes(groupBy)) groupBy = 'day';

  const today = new Date();
  const startOfMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const yesterday    = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()-1));

  const from = ymd(parseDate(req.query.from, startOfMonth));
  const to   = ymd(parseDate(req.query.to,   yesterday));

  const sql = groupBy === 'day'
    ? `
      SELECT day AS bucket, SUM(qty)::numeric AS qty, SUM(amount)::numeric AS amount
      FROM public.maxi_sales_daily
      WHERE business_id=$1 AND articulo_id=$2
        AND day >= $3::date AND day <= $4::date
      GROUP BY day
      ORDER BY bucket
    `
    : `
      SELECT date_trunc($5, day)::date AS bucket,
             SUM(qty)::numeric AS qty, SUM(amount)::numeric AS amount
      FROM public.maxi_sales_daily
      WHERE business_id=$1 AND articulo_id=$2
        AND day >= $3::date AND day <= $4::date
      GROUP BY bucket
      ORDER BY bucket
    `;
  const params = groupBy === 'day'
    ? [businessId, articuloId, from, to]
    : [businessId, articuloId, from, to, groupBy];

  const { rows } = await db.query(sql, params);
  res.json({ ok:true, business_id: businessId, articuloId, from, to, groupBy, items: rows });
};

exports.peekArticlesTree = async (req,res)=>{
  const businessId = req.businessId;
  const { rows } = await db.query(`
    SELECT articulo_id, nombre, categoria, subrubro, precio
    FROM public.maxi_articles
    WHERE business_id=$1
    ORDER BY subrubro, categoria, nombre
  `,[businessId]);

  const bySub = new Map();
  for (const r of rows) {
    const sub = (r.subrubro && r.subrubro.trim()) || 'Sin subrubro';
    const cat = (r.categoria && r.categoria.trim()) || 'Sin categoría';
    if (!bySub.has(sub)) bySub.set(sub, new Map());
    const byCat = bySub.get(sub);
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat).push({ id:r.articulo_id, nombre:r.nombre, precio:r.precio ?? null });
  }
  const tree = Array.from(bySub.entries()).map(([subrubro, byCat])=>({
    subrubro,
    categorias: Array.from(byCat.entries()).map(([categoria, articulos])=>({ categoria, articulos }))
  }));
  const resumen = {
    subrubros: tree.length,
    categorias: tree.reduce((a,s)=>a+(s.categorias?.length||0),0),
    articulos: tree.reduce((a,s)=>a+s.categorias.reduce((x,c)=>x+(c.articulos?.length||0),0),0)
  };
  res.json({ ok:true, business_id: businessId, resumen, tree });
};

exports.peekMaxiStatus = async (req,res)=>{
  const businessId = req.businessId;
  const { rows } = await db.query(`SELECT props FROM app_businesses WHERE id=$1 LIMIT 1`,[businessId]);
  const mx = (rows[0]?.props || {}).maxi || {};
  const configured = !!(mx.email && (mx.pass_enc || mx.password) && mx.codcli);
  res.json({ ok:true, business_id: businessId, configured, email: mx.email || null, codcli: mx.codcli || null });
};

exports.peekMaxiMenuCache = async (req,res)=>{
  const businessId = req.businessId;
  const { rows } = await db.query(`
    SELECT hash, updated_at, jsonb_array_length(payload) AS items_len
    FROM public.maxi_menu_cache
    WHERE business_id=$1
    ORDER BY updated_at DESC
    LIMIT 1
  `,[businessId]);
  res.json({ ok:true, business_id: businessId, cache: rows[0] || null });
};
