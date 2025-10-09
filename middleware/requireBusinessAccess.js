// middleware/requireBusinessAccess.js
const pool = require('../config/db');

module.exports = async function requireBusinessAccess(req, res, next, rawId) {
  try {
    const uid = req.user?.id;
    const id = Number(rawId);
    if (!uid) return res.status(401).json({ error: 'unauthorized' });
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_business_id' });

    // Verifica acceso (owner o miembro) y trae la fila
    const { rows } = await pool.query(
      `SELECT b.id, b.owner_id, b.name, b.slug, b.color_hex, b.brand_logo_url, b.brand_font, b.props
         FROM app_businesses b
    LEFT JOIN user_businesses ub ON ub.business_id = b.id
        WHERE b.id = $1 AND (b.owner_id = $2 OR ub.user_id = $2)
        LIMIT 1`,
      [id, uid]
    );
    const biz = rows[0];
    if (!biz) return res.status(404).json({ error: 'not_found' }); // o 403 si preferís

    req.businessId = biz.id;
    req.business   = biz;
    next();
  } catch (e) {
    console.error('requireBusinessAccess error:', e);
    res.status(500).json({ error: 'internal' });
  }
};
