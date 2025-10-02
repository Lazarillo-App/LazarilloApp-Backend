// middleware/business.js
const pool = require('../config/db');

async function loadActiveBusiness(req, res, next) {
  try {
    const uid = req.user?.id;
    if (!uid) return res.status(401).json({ error: 'unauthorized' });

    // Prioridad: header -> param (:id o :businessId) -> parseo URL -> active_business_id
    let override =
      req.header('x-business-id') ||
      req.params?.id ||
      req.params?.businessId ||
      null;

    if (!override) {
      const m = req.originalUrl.match(/\/api\/businesses\/(\d+)/);
      if (m) override = m[1];
    }

    let businessId = Number(override);
    if (!Number.isFinite(businessId)) {
      const { rows } = await pool.query(
        'SELECT active_business_id FROM app_users WHERE id=$1',
        [uid]
      );
      businessId = Number(rows[0]?.active_business_id);
    }

    if (!Number.isFinite(businessId)) {
      // No hay negocio → dejamos nulos; los controllers decidirán si lo requieren.
      req.businessId = null;
      req.business = null;
      return next();
    }

    const { rows } = await pool.query(`
      SELECT b.id, b.name, b.slug, b.color_hex, b.props
      FROM app_businesses b
      LEFT JOIN user_businesses ub ON ub.business_id = b.id
      WHERE b.id = $1 AND (b.owner_id = $2 OR ub.user_id = $2)
      LIMIT 1
    `, [businessId, uid]);

    if (!rows[0]) {
      // Sólo bloqueá si expresamente vino un id/override invalido
      return res.status(403).json({ error: 'no_access_to_business' });
    }

    req.businessId = rows[0].id;
    req.business = rows[0];
    next();
  } catch (e) {
    next(e);
  }
}

function requireBusiness(req, res, next) {
  if (!req.businessId) return res.status(400).json({ error: 'no_active_business' });
  next();
}

module.exports = { loadActiveBusiness, requireBusiness };
