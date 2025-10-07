// middleware/business.js
const pool = require('../config/db');

async function loadActiveBusiness(req, res, next) {
  try {
    const uid = req.user?.id;
    if (!uid) return res.status(401).json({ error: 'unauthorized' });

    // Prioridad: header -> query -> param -> activo del usuario
    const headerId = req.header('x-business-id');
    const queryId  = req.query.businessId;
    const paramId  = req.params.businessId || req.params.id;
    let source = 'none';
    let businessId = null;

    if (headerId) { businessId = Number(headerId); source = 'header'; }
    else if (queryId) { businessId = Number(queryId); source = 'query'; }
    else if (paramId) { businessId = Number(paramId); source = 'param'; }
    else {
      const { rows } = await pool.query(
        'SELECT active_business_id FROM app_users WHERE id=$1',
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
      LEFT JOIN user_businesses ub ON ub.business_id=b.id
      WHERE b.id=$1 AND (b.owner_id=$2 OR ub.user_id=$2)
      LIMIT 1
    `, [businessId, uid]);

    const row = rows[0];
    if (!row) {
      if (source === 'header' || source === 'query' || source === 'param') {
        return res.status(403).json({ error: 'no_access_to_business' });
      }
      req.business = null;
      req.businessId = null;
      return next();
    }

    // props siempre como objeto
    let props = row.props;
    if (!props || typeof props !== 'object') props = {};
    if (!props.maxi || typeof props.maxi !== 'object') props.maxi = {};
    // (si guardás con mayúscula 'Maxi', normalizá)
    if (!props.maxi.email && props.Maxi?.email) props.maxi = { ...props.maxi, ...props.Maxi };

    req.business = { ...row, props };
    req.businessId = row.id;
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

