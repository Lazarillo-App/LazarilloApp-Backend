// middleware/business.js
const pool = require('../config/db');

async function loadActiveBusiness(req, res, next) {
  try {
    const uid = req.user?.id;
    if (!uid) return res.status(401).json({ error: 'unauthorized' });

    // Prioridad y de dónde salió:
    const headerId = req.header('x-business-id');
    const paramId  = req.params.id || req.params.businessId;
    let source = 'none';
    let businessId = null;

    if (headerId) { businessId = Number(headerId); source = 'header'; }
    else if (paramId) { businessId = Number(paramId); source = 'param'; }
    else {
      // fallback: activo del usuario (no debe bloquear si no pertenece)
      const { rows } = await pool.query(
        'SELECT active_business_id FROM app_users WHERE id = $1',
        [uid]
      );
      businessId = Number(rows[0]?.active_business_id);
      source = 'active';
    }

    if (!Number.isFinite(businessId)) {
      req.business = null;
      req.businessId = null;
      return next();
    }

    const { rows } = await pool.query(`
      SELECT b.id, b.name, b.slug, b.color_hex, b.props
      FROM app_businesses b
      LEFT JOIN user_businesses ub ON ub.business_id = b.id
      WHERE b.id = $1 AND (b.owner_id = $2 OR ub.user_id = $2)
      LIMIT 1;
    `, [businessId, uid]);

    if (!rows[0]) {
      // Solo bloquear si el id vino EXPLÍCITO (header/param).
      if (source === 'header' || source === 'param') {
        return res.status(403).json({ error: 'no_access_to_business' });
      }
      // Si vino del "activo" y no pertenece, lo ignoramos y seguimos sin business.
      req.business = null;
      req.businessId = null;
      return next();
    }

    req.business = rows[0];
    req.businessId = rows[0].id;
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
