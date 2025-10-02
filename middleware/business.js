// middleware/business.js
const pool = require('../config/db');

async function loadActiveBusiness(req, res, next) {
  try {
    const uid = req.user?.id;
    if (!uid) return res.status(401).json({ error: 'unauthorized' });

    // fuente: 'header' | 'param' | 'auto' | null
    let source = null;

    let override =
      req.header('x-business-id') ||
      req.params?.id ||
      req.params?.businessId ||
      null;

    if (override) {
      source = req.header('x-business-id') ? 'header' : 'param';
    } else {
      const m = req.originalUrl.match(/\/api\/businesses\/(\d+)/);
      if (m) { override = m[1]; source = 'param'; }
    }

    let businessId = Number(override);
    if (!Number.isFinite(businessId)) {
      // fallback: activo del usuario
      const { rows } = await pool.query(
        'SELECT active_business_id FROM app_users WHERE id=$1',
        [uid]
      );
      businessId = Number(rows[0]?.active_business_id);
      source = Number.isFinite(businessId) ? 'auto' : null;
    }

    if (!Number.isFinite(businessId)) {
      req.businessId = null;
      req.business = null;
      return next();
    }

    // validar pertenencia
    const { rows } = await pool.query(`
      SELECT b.id, b.name, b.slug, b.color_hex, b.props
      FROM app_businesses b
      LEFT JOIN user_businesses ub ON ub.business_id = b.id
      WHERE b.id = $1 AND (b.owner_id = $2 OR ub.user_id = $2)
      LIMIT 1
    `, [businessId, uid]);

    if (!rows[0]) {
      if (source === 'auto') {
        // activo roto → limpiamos y seguimos sin cortar
        await pool.query(
          'UPDATE app_users SET active_business_id=NULL WHERE id=$1',
          [uid]
        );
        req.businessId = null;
        req.business = null;
        return next();
      }
      // si fue explícito (header/param), sí bloqueamos
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
