// middleware/activeBusiness.js
const pool = require('../config/db');

async function loadActiveBusiness(req, res, next) {
  try {
    // 1) De dónde sale el businessId (Header > query > body)
    const raw = req.get('X-Business-Id') ?? req.query.businessId ?? req.body?.businessId;
    const businessId = Number(raw);
    if (!Number.isFinite(businessId)) {
      req.business = null;
      req.membership = null;
      return next(); // algunos endpoints no necesitan negocio
    }

    // 2) Traer negocio
    const biz = await pool.query(
      `SELECT id, name, props, status, created_from, organization_id FROM app_businesses WHERE id = $1`,
      [businessId]
    );
    if (biz.rowCount === 0) {
      return res.status(404).json({ error: 'business_not_found', business_id: businessId });
    }

    req.business = biz.rows[0];

    // 3) Si hay usuario autenticado, buscar su membership
    if (req.user?.id) {
      const mem = await pool.query(
        `SELECT id, business_id, user_id, role
           FROM app_memberships
          WHERE business_id = $1 AND user_id = $2`,
        [businessId, req.user.id]
      );
      req.membership = mem.rows[0] || null;
    } else {
      req.membership = null;
    }

    next();
  } catch (e) {
    next(e);
  }
}

module.exports = { loadActiveBusiness };