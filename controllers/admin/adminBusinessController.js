// controllers/admin/adminBusinessController.js
const db = require('../../config/db');
const { logAudit, computeDiff } = require('../../services/audit/auditLog');

exports.listBusinesses = async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize || '20', 10), 1), 100);
    const offset = (page - 1) * pageSize;

    const params = [];
    let where = '';
    if (q) {
      params.push(`%${q}%`);
      where = `WHERE b.name ILIKE $1`;
    }

    const [{ count }] = (await db.query(
      `SELECT COUNT(*)::int count FROM app_businesses b ${where}`, params
    )).rows;

    const rows = (await db.query(
      `SELECT b.id, b.name, b.slug, b.organization_id, o.name AS organization_name,
              b.owner_id, u.name AS owner_name, u.email AS owner_email,
              u.status AS owner_status, u.account_status AS owner_account_status,
              b.created_at
         FROM app_businesses b
         LEFT JOIN organizations o ON o.id = b.organization_id
         LEFT JOIN app_users u ON u.id = b.owner_id
        ${where}
        ORDER BY b.created_at DESC
        LIMIT ${pageSize} OFFSET ${offset}`,
      params
    )).rows;

    res.json({ page, pageSize, total: count, rows });
  } catch (e) {
    console.error('ADMIN_BUSINESSES_LIST_FAILED:', e);
    res.status(500).json({ error: 'ADMIN_BUSINESSES_LIST_FAILED' });
  }
};

exports.getBusiness = async (req, res) => {
  try {
    const id = Number(req.params.id);

    const { rows } = await db.query(
      `SELECT b.id, b.name, b.slug, b.color_hex, b.organization_id, o.name AS organization_name,
              b.owner_id, u.name AS owner_name, u.email AS owner_email,
              u.status AS owner_status, u.account_status AS owner_account_status,
              b.created_at
         FROM app_businesses b
         LEFT JOIN organizations o ON o.id = b.organization_id
         LEFT JOIN app_users u ON u.id = b.owner_id
        WHERE b.id = $1
        LIMIT 1`,
      [id]
    );
    const business = rows[0];
    if (!business) return res.status(404).json({ error: 'NOT_FOUND' });

    // Staff del negocio: mismo criterio que teamController::listMembers (scope
    // 'business'), incluyendo el owner sintético cuando no tiene fila propia en
    // user_assignments. El admin ve todo, sin el filtro de "solo lo que él creó".
    const { rows: staff } = await db.query(
      `
      SELECT * FROM (
        SELECT ua.id, ua.user_id, ua.role, COALESCE(ua.self_alias, ua.alias) AS alias,
               ua.granted_by_user_id, ua.created_at,
               u.email, u.name, u.account_status
          FROM user_assignments ua
          JOIN app_users u ON u.id = ua.user_id
         WHERE ua.scope_type = 'business' AND ua.scope_id = $1 AND ua.revoked_at IS NULL
        UNION ALL
        SELECT NULL::bigint AS id, b.owner_id AS user_id, 'owner'::text AS role,
               u.name AS alias, NULL::bigint AS granted_by_user_id, u.created_at,
               u.email, u.name, u.account_status
          FROM app_businesses b
          JOIN app_users u ON u.id = b.owner_id
         WHERE b.id = $1 AND b.owner_id IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM user_assignments ua2
              WHERE ua2.scope_type = 'business' AND ua2.scope_id = b.id
                AND ua2.user_id = b.owner_id AND ua2.revoked_at IS NULL
           )
      ) t
      ORDER BY CASE t.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, t.created_at ASC
      `,
      [id]
    );

    res.json({ ok: true, business, staff });
  } catch (e) {
    console.error('ADMIN_BUSINESS_GET_FAILED:', e);
    res.status(500).json({ error: 'internal' });
  }
};

exports.updateBusiness = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { name, slug, color_hex, organization_id } = req.body || {};

    const { rows: beforeRows } = await db.query(
      `SELECT id, name, slug, color_hex, organization_id FROM app_businesses WHERE id=$1 LIMIT 1`,
      [id]
    );
    const before = beforeRows[0];
    if (!before) return res.status(404).json({ error: 'NOT_FOUND' });

    const fields = [];
    const values = [];
    let i = 1;
    if (name != null)  { fields.push(`name=$${i++}`);  values.push(name); }
    if (slug != null)  { fields.push(`slug=$${i++}`);  values.push(slug); }
    if (color_hex != null) { fields.push(`color_hex=$${i++}`); values.push(color_hex); }
    if (organization_id !== undefined) { fields.push(`organization_id=$${i++}`); values.push(organization_id); }

    if (!fields.length) return res.json({ ok: true });

    values.push(id);
    const { rows } = await db.query(
      `UPDATE app_businesses SET ${fields.join(', ')} WHERE id=$${i}
       RETURNING id, name, slug, color_hex, organization_id`,
      values
    );

    await logAudit(null, {
      userId: req.user?.id || null,
      businessId: id,
      entityType: 'business',
      entityId: id,
      action: 'update',
      diff: computeDiff(before, rows[0]),
    });

    res.json({ ok: true, business: rows[0] });
  } catch (e) {
    console.error('ADMIN_BUSINESS_UPDATE_FAILED:', e);
    res.status(500).json({ error: 'internal' });
  }
};
