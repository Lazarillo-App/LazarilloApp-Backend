// middleware/business.js
const pool = require('../config/db');

exports.loadActiveBusiness = async (req, res, next) => {
  try {
    const headerBid = req.header('X-Business-Id');
    let bizId = Number.isFinite(Number(headerBid)) ? Number(headerBid) : null;

    if (!bizId) {
      // cae al activo del usuario
      const { rows } = await pool.query(
        'SELECT active_business_id FROM app_users WHERE id=$1',
        [req.user.id]
      );
      bizId = rows[0]?.active_business_id || null;
    }

    if (!bizId) return res.status(404).json({ error: 'no_active_business' });

    // verifica acceso del usuario
    const { rows: link } = await pool.query(
      `SELECT 1 FROM user_businesses WHERE user_id=$1 AND business_id=$2 LIMIT 1`,
      [req.user.id, bizId]
    );
    if (!link[0]) return res.status(403).json({ error: 'no_access_to_business' });

    req.bizId = bizId;
    next();
  } catch (e) {
    console.error('loadActiveBusiness error:', e);
    res.status(500).json({ error: 'internal' });
  }
};
