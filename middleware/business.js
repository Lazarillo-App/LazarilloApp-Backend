const pool = require('../config/db');

exports.loadActiveBusiness = async (req, res, next) => {
try {
    if (req.user?.role === 'app_admin') {
      return res.status(403).json({ error: 'forbidden_for_app_admin' });
    }

    const headerId = req.header('X-Business-Id');
    const queryId  = req.query.businessId;
    const paramId  = req.params.businessId || req.params.id;
    let source = 'none';
    let bizId = null;

    if (headerId)      { bizId = Number(headerId); source = 'header'; }
    else if (queryId)  { bizId = Number(queryId);  source = 'query'; }
    else if (paramId)  { bizId = Number(paramId);  source = 'param'; }
    else {
      const { rows } = await pool.query(
        'SELECT active_business_id FROM app_users WHERE id=$1 LIMIT 1',
        [uid]
      );
      bizId = Number(rows[0]?.active_business_id || null);
      source = 'active';
    }

    if (!Number.isFinite(bizId)) { // seguir sin negocio (algunas rutas no lo requieren)
      req.businessId = null;
      req.business = null;
      return next();
    }

    const { rows } = await pool.query(`
      SELECT b.*
        FROM app_businesses b
        LEFT JOIN user_businesses ub ON ub.business_id = b.id AND ub.user_id = $2
       WHERE b.id = $1 AND (b.owner_id = $2 OR ub.user_id IS NOT NULL)
       LIMIT 1
    `, [bizId, uid]);

    if (!rows[0]) {
      if (['header','query','param'].includes(source)) {
        return res.status(403).json({ error: 'no_access_to_business' });
      }
      req.businessId = null;
      req.business = null;
      return next();
    }

    const row = rows[0];
    const props = (row.props && typeof row.props === 'object') ? row.props : {};
    if (!props.maxi) props.maxi = {};
    req.businessId = row.id;
    req.business   = { ...row, props };
    next();
  } catch (e) {
    console.error('loadActiveBusiness error:', e);
    res.status(500).json({ error: 'internal' });
  }
};