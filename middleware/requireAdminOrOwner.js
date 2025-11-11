// middleware/requireAdminOrOwner.js
const pool = require('../config/db');

module.exports = function requireAdminOrOwner(paramName = 'businessId') {
  return async (req, res, next) => {
    try {
      const u = req.user;
      if (!u) return res.status(401).json({ error: 'unauthorized' });

      // admin global habilita todo
      if (u.role === 'app_admin' || u.props?.is_admin === true) return next();

      // si no es admin, debe ser owner del negocio afectado
      const biz = Number(req.params[paramName] || req.query[paramName] || req.body?.[paramName]);
      if (!Number.isFinite(biz)) return res.status(400).json({ error: 'businessId_required' });

      const { rows } = await pool.query(
        `SELECT 1 FROM user_business_roles WHERE user_id=$1 AND business_id=$2 AND role='owner' LIMIT 1`,
        [u.id, biz]
      );
      if (rows.length) return next();

      return res.status(403).json({ error: 'forbidden_admin_or_owner_only' });
    } catch (e) {
      next(e);
    }
  };
};
