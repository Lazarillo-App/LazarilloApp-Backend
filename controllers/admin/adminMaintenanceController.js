// controllers/admin/adminMaintenanceController.js
const db = require('../../config/db');
const { logAudit } = require('../../services/audit/auditLog');
const { invalidateMaintenanceCache } = require('../../middleware/maintenanceMode');

exports.getMaintenance = async (_req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT value, updated_at, updated_by FROM platform_settings WHERE key='maintenance' LIMIT 1`
    );
    const value = rows[0]?.value || { enabled: false };
    res.json({ ok: true, ...value, updated_at: rows[0]?.updated_at || null, updated_by: rows[0]?.updated_by || null });
  } catch (e) {
    console.error('ADMIN_GET_MAINTENANCE_FAILED:', e);
    res.status(500).json({ error: 'internal' });
  }
};

exports.setMaintenance = async (req, res) => {
  try {
    const { enabled, message } = req.body || {};
    const value = { enabled: !!enabled, message: message || null };

    await db.query(
      `INSERT INTO platform_settings (key, value, updated_at, updated_by)
       VALUES ('maintenance', $1::jsonb, NOW(), $2)
       ON CONFLICT (key) DO UPDATE SET value=$1::jsonb, updated_at=NOW(), updated_by=$2`,
      [JSON.stringify(value), req.user?.id || null]
    );
    invalidateMaintenanceCache();

    await logAudit(null, {
      userId: req.user?.id || null,
      entityType: 'platform',
      entityId: 0,
      action: 'update',
      diff: { after: value },
      metadata: { setting: 'maintenance' },
    });

    res.json({ ok: true, ...value });
  } catch (e) {
    console.error('ADMIN_SET_MAINTENANCE_FAILED:', e);
    res.status(500).json({ error: 'internal' });
  }
};
