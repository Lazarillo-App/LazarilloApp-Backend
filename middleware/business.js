const pool = require('../config/db');

exports.loadActiveBusiness = async (req, res, next) => {
  try {
    const override = req.header('x-business-id'); // opcional para cambiar contexto por request
    let businessId = override;

    if (!businessId) {
      const { rows } = await pool.query(
        'SELECT active_business_id FROM app_users WHERE id = $1',
        [req.user.id]
      );
      businessId = rows[0]?.active_business_id || null;
    }

    if (!businessId) {
      req.business = null; // el usuario aún no creó/seleccionó negocio
      return next();
    }

    const { rows: own } = await pool.query(
      `SELECT b.* FROM businesses b
         JOIN user_business_roles ubr ON ubr.business_id = b.id
        WHERE b.id = $1 AND ubr.user_id = $2`,
      [businessId, req.user.id]
    );

    if (!own[0]) return res.status(403).json({ error: 'no_access_to_business' });

    req.business = own[0]; // negocio activo
    next();
  } catch (e) {
    next(e);
  }
};

exports.requireBusiness = (req, res, next) => {
  if (!req.business) return res.status(400).json({ error: 'no_active_business' });
  next();
};
