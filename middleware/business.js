// middleware/businesses.js
const pool = require('../config/db');

// Lee el negocio activo (o el pasado por header/param) y valida pertenencia
async function loadActiveBusiness(req, res, next) {
  try {
    const uid = req.user?.id;
    if (!uid) return res.status(401).json({ error: 'unauthorized' });

    // Prioridad: header X-Business-Id -> param :id -> active_business_id del usuario
    const override = req.header('x-business-id') || req.params.id || null;

    let businessId = override;
    if (!businessId) {
      const { rows } = await pool.query(
        'SELECT active_business_id FROM app_users WHERE id = $1',
        [uid]
      );
      businessId = rows[0]?.active_business_id || null;
    }

    if (!businessId) { // el usuario no tiene activo ninguno
      req.business = null;
      return next();
    }

    // Valida pertenencia (dueño o miembro)
    const { rows } = await pool.query(`
      SELECT b.id, b.name, b.slug, b.color_hex, b.props
      FROM app_businesses b
      LEFT JOIN user_businesses ub ON ub.business_id = b.id
      WHERE b.id = $1 AND (b.owner_id = $2 OR ub.user_id = $2)
      LIMIT 1;
    `, [businessId, uid]);

    if (!rows[0]) return res.status(403).json({ error: 'no_access_to_business' });

    req.business = rows[0];
    req.businessId = rows[0].id;
    next();
  } catch (e) {
    next(e);
  }
}

function requireBusiness(req, res, next) {
  if (!req.business) return res.status(400).json({ error: 'no_active_business' });
  next();
}

module.exports = { loadActiveBusiness, requireBusiness };
