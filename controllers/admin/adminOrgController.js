// controllers/admin/adminOrgController.js
const db = require('../../config/db');

exports.listOrganizations = async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize || '20', 10), 1), 100);
    const offset = (page - 1) * pageSize;

    const params = [];
    let where = '';
    if (q) {
      params.push(`%${q}%`);
      where = `WHERE o.name ILIKE $1`;
    }

    const [{ count }] = (await db.query(
      `SELECT COUNT(*)::int count FROM organizations o ${where}`, params
    )).rows;

    const rows = (await db.query(
      `SELECT o.id, o.name, o.display_name, o.maxi_codcli, o.created_at,
              COUNT(b.id)::int AS business_count
         FROM organizations o
         LEFT JOIN app_businesses b ON b.organization_id = o.id
        ${where}
        GROUP BY o.id
        ORDER BY o.created_at DESC
        LIMIT ${pageSize} OFFSET ${offset}`,
      params
    )).rows;

    res.json({ page, pageSize, total: count, rows });
  } catch (e) {
    console.error('ADMIN_ORGS_LIST_FAILED:', e);
    res.status(500).json({ error: 'internal' });
  }
};

exports.getOrganization = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { rows } = await db.query(
      `SELECT id, name, display_name, maxi_codcli, settings, created_at FROM organizations WHERE id=$1 LIMIT 1`,
      [id]
    );
    const organization = rows[0];
    if (!organization) return res.status(404).json({ error: 'NOT_FOUND' });

    const { rows: businesses } = await db.query(
      `SELECT b.id, b.name, b.slug, b.owner_id, u.name AS owner_name, u.email AS owner_email
         FROM app_businesses b
         LEFT JOIN app_users u ON u.id = b.owner_id
        WHERE b.organization_id = $1
        ORDER BY b.name`,
      [id]
    );

    res.json({ ok: true, organization, businesses });
  } catch (e) {
    console.error('ADMIN_ORG_GET_FAILED:', e);
    res.status(500).json({ error: 'internal' });
  }
};
