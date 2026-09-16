// controllers/admin/adminAuditController.js
const db = require('../../config/db');

/**
 * GET /admin/audit
 * Historial de acciones de plataforma: por default, todo lo hecho por
 * cualquier cuenta con role='app_admin' (puede haber más de una). Filtros
 * opcionales: entityType, userId, businessId, from, to.
 */
exports.listPlatformAudit = async (req, res) => {
  try {
    const { entityType, userId, businessId, from, to } = req.query;
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize || '30', 10), 1), 100);
    const offset = (page - 1) * pageSize;

    const conditions = [`admins.role = 'app_admin'`];
    const params = [];
    let i = 1;

    if (entityType) { conditions.push(`al.entity_type = $${i++}`); params.push(entityType); }
    if (userId)     { conditions.push(`al.user_id = $${i++}`); params.push(Number(userId)); }
    if (businessId) { conditions.push(`al.business_id = $${i++}`); params.push(Number(businessId)); }
    if (from)       { conditions.push(`al.created_at >= $${i++}`); params.push(from); }
    if (to)         { conditions.push(`al.created_at <= $${i++}`); params.push(to); }

    const where = `WHERE ${conditions.join(' AND ')}`;

    const [{ count }] = (await db.query(
      `SELECT COUNT(*)::int count
         FROM audit_log al
         JOIN app_users admins ON admins.id = al.user_id
        ${where}`,
      params
    )).rows;

    const rows = (await db.query(
      `SELECT al.id, al.business_id, al.organization_id, al.user_id,
              admins.name AS admin_name, admins.email AS admin_email,
              al.entity_type, al.entity_id, al.action, al.diff, al.metadata, al.created_at
         FROM audit_log al
         JOIN app_users admins ON admins.id = al.user_id
        ${where}
        ORDER BY al.created_at DESC
        LIMIT ${pageSize} OFFSET ${offset}`,
      params
    )).rows;

    res.json({ page, pageSize, total: count, rows });
  } catch (e) {
    console.error('ADMIN_AUDIT_LIST_FAILED:', e);
    res.status(500).json({ error: 'internal' });
  }
};
