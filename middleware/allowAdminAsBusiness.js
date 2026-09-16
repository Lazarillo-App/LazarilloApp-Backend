// middleware/allowAdminAsBusiness.js
const pool = require('../config/db');
const { logAudit } = require('../services/audit/auditLog');

module.exports = async function allowAdminAsBusiness(req, res, next) {
  try {
    if (req.user?.role !== 'app_admin') {
      return res.status(403).json({ error: 'forbidden' });
    }

    const paramId = req.params?.id;
    const qId = req.query?.as_business_id;
    const hId = req.header('X-As-Business-Id');
    const id = Number(paramId ?? qId ?? hId ?? req.businessId);

    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_business_id' });

    const { rows } = await pool.query(
      `SELECT id, owner_id, name, slug, color_hex, brand_logo_url, brand_font, props
         FROM app_businesses
        WHERE id = $1
        LIMIT 1`,
      [id]
    );
    const biz = rows[0];
    if (!biz) return res.status(404).json({ error: 'not_found' });

    req.businessId = biz.id;
    req.business   = biz;

    // Auditoría: queda registro de cuándo y por qué se entró a ver un negocio
    // ajeno en modo solo-lectura (nunca de escritura), sin frenar la request
    // si el logging falla.
    logAudit(null, {
      userId: req.user?.id || null,
      businessId: biz.id,
      entityType: 'business',
      entityId: biz.id,
      action: 'view',
      metadata: { path: req.originalUrl },
    }).catch(() => {});

    next();
  } catch (e) {
    console.error('allowAdminAsBusiness error:', e);
    res.status(500).json({ error: 'internal' });
  }
};
