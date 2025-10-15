// middleware/authMiddleware.js
const jwt = require('jsonwebtoken');
const SECRET = process.env.JWT_SECRET || 'dev-secret';
const SERVICE_BEARER = (process.env.SERVICE_BEARER || '').trim();
const pool = require('../config/db');

// === authRequired ===
async function authRequired(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    const m = h.match(/^Bearer\s+(.+)$/i);
    if (!m) return res.status(401).json({ error: 'missing_token' });

    const token = m[1].trim();

    // 1) Fast-path: token de servicio (no es JWT)
    if (SERVICE_BEARER && token === SERVICE_BEARER) {
      req.user = { id: 0, email: null, role: 'service' };
      req.isService = true;
      return next();
    }

    // 2) Caso normal: JWT de usuario
    let payload;
    try {
      payload = jwt.verify(token, SECRET);
    } catch {
      return res.status(401).json({ error: 'invalid_token' });
    }
    req.user = { id: payload.uid, email: payload.email, role: payload.role || null };
    req.isService = false;
    next();
  } catch (e) {
    console.error('authRequired error:', e);
    res.status(500).json({ error: 'internal' });
  }
}

// === loadActiveBusiness ===
async function loadActiveBusiness(req, res, next) {
  try {
    // Los app_admin no usan estos endpoints
    if (req.user?.role === 'app_admin' && !req.isService) {
      return res.status(403).json({ error: 'forbidden_for_app_admin' });
    }

    const uid = req.user?.id ?? null;
    const headerId = req.header('X-Business-Id');
    const queryId  = req.query.businessId;
    const paramId  = req.params.businessId || req.params.id;

    let source = 'none';
    let bizId = null;

    if (headerId)      { bizId = Number(headerId); source = 'header'; }
    else if (queryId)  { bizId = Number(queryId);  source = 'query'; }
    else if (paramId)  { bizId = Number(paramId);  source = 'param'; }
    else if (!req.isService) {
      // Sólo usuarios reales tienen active_business_id
      const { rows } = await pool.query(
        'SELECT active_business_id FROM app_users WHERE id=$1 LIMIT 1',
        [uid]
      );
      bizId = Number(rows[0]?.active_business_id || null);
      source = 'active';
    }

    if (!Number.isFinite(bizId)) {
      req.businessId = null;
      req.business = null;
      return next();
    }

    // Service user: NO chequear pertenencia; sólo existe el negocio
    if (req.isService) {
      const { rows } = await pool.query(
        'SELECT * FROM app_businesses WHERE id = $1 LIMIT 1',
        [bizId]
      );
      if (!rows[0]) return res.status(404).json({ error: 'business_not_found' });

      const row = rows[0];
      const props = (row.props && typeof row.props === 'object') ? row.props : {};
      if (!props.maxi) props.maxi = {};
      req.businessId = row.id;
      req.business   = { ...row, props };
      return next();
    }

    // Usuario real: chequear dueño/relación
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
}

module.exports = { authRequired, loadActiveBusiness };
