// controllers/auditLogController.js
'use strict';

const pool = require('../config/db');
const { getEffectiveRole } = require('../services/auth/accessControl');

/* ══════════════════════════════════════════════════════════════
   GET /api/businesses/:businessId/audit-log
   Historial de actividad del equipo (owner/admin únicamente).

   Query params opcionales:
     entityType  - filtra por tipo ('receta' | 'receta_elaborado' | 'insumo' |
                   'merma' | 'receta_item_merma' | 'precio_config', etc.)
     userId      - filtra por autor del cambio
     limit       - default 50, máx 200
     before      - id de audit_log para paginar hacia atrás (más viejos que este)
══════════════════════════════════════════════════════════════ */
exports.listAuditLog = async (req, res, next) => {
  try {
    const bizId = Number(req.params.businessId);
    if (!bizId) return res.status(400).json({ ok: false, error: 'invalid_business_id' });

    const uid = req.user?.id;
    const role = await getEffectiveRole(uid, bizId);
    if (!['owner', 'admin'].includes(role)) {
      return res.status(403).json({ ok: false, error: 'owner_or_admin_required' });
    }

    const { entityType, userId, before } = req.query;
    const limit = Math.min(Number(req.query.limit) || 50, 200);

    const where = ['business_id = $1'];
    const params = [bizId];

    if (entityType) {
      params.push(entityType);
      where.push(`entity_type = $${params.length}`);
    }
    if (userId) {
      params.push(Number(userId));
      where.push(`user_id = $${params.length}`);
    }
    if (before) {
      params.push(Number(before));
      where.push(`id < $${params.length}`);
    }

    params.push(limit);

    const { rows } = await pool.query(
      `SELECT id, user_id, user_alias_snapshot, entity_type, entity_id,
              action, diff, metadata, created_at
         FROM audit_log
        WHERE ${where.join(' AND ')}
        ORDER BY id DESC
        LIMIT $${params.length}`,
      params
    );

    return res.json({ ok: true, data: rows, hasMore: rows.length === limit });
  } catch (e) {
    console.error('[listAuditLog]', e);
    next(e);
  }
};
