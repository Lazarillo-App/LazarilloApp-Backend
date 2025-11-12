// middleware/allowAdminAsBusiness.js
const pool = require('../config/db');

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
    next();
  } catch (e) {
    console.error('allowAdminAsBusiness error:', e);
    res.status(500).json({ error: 'internal' });
  }
};
