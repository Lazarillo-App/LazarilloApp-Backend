// middleware/business.js
const pool = require('../config/db');

function parseId(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function loadActiveBusiness(req, res, next) {
  try {
    const uid = req.user?.id;
    if (!uid) return res.status(401).json({ error: 'unauthorized' });

    const headerId = req.header('x-business-id');
    const paramId  = req.params.id || req.params.businessId;
    const queryId  = req.query.businessId;              // 👈 NUEVO
    let source = 'none';
    let businessId = null;

    if (headerId)      { businessId = Number(headerId); source = 'header'; }
    else if (paramId)  { businessId = Number(paramId);  source = 'param';  }
    else if (queryId)  { businessId = Number(queryId);  source = 'query';  } // 👈 NUEVO
    else {
      const { rows } = await pool.query(
        'SELECT active_business_id FROM app_users WHERE id = $1',
        [uid]
      );
      businessId = Number(rows[0]?.active_business_id);
      source = 'active';
    }

    if (!businessId) {
      req.business = null;
      req.businessId = null;
      req.businessSource = source;
      return next();
    }

    // 3) Validar pertenencia: owner o está linkeado en user_businesses
    const { rows } = await pool.query(
      `
      SELECT b.id, b.name, b.slug, b.color_hex, b.props
      FROM app_businesses b
      WHERE b.id = $1
        AND (
          b.owner_id = $2
          OR EXISTS (
            SELECT 1 FROM user_businesses ub
            WHERE ub.business_id = b.id AND ub.user_id = $2
          )
        )
      LIMIT 1
      `,
      [businessId, uid]
    );

    if (!rows[0]) {
      if (source === 'header' || source === 'param' || source === 'query') {
        return res.status(403).json({ error: 'no_access_to_business' });
      }
      // vino del activo pero no pertenece => seguir sin contexto
      req.business = null;
      req.businessId = null;
      req.businessSource = source;
      return next();
    }

    // 4) Contexto de negocio listo para controllers
    req.business = rows[0];            // { id, name, slug, color_hex, props }
    req.businessId = rows[0].id;
    req.businessSource = source;
    next();
  } catch (e) {
    next(e);
  }
}

function requireBusiness(req, res, next) {
  if (!req.businessId) {
    return res.status(400).json({ error: 'no_active_business' });
  }
  next();
}

module.exports = { loadActiveBusiness, requireBusiness };
