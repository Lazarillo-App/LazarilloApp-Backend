// middleware/authMiddleware.js
const jwt = require('jsonwebtoken');
const SECRET = process.env.JWT_SECRET || 'dev-secret';
const SERVICE_BEARER = process.env.SERVICE_BEARER || null;
const pool = require('../config/db');

/**
 * authRequired
 * - Si Authorization trae el SERVICE_BEARER => entra como rol "service" sin JWT.
 * - Si no, valida JWT normal.
 */
async function authRequired(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    const m = h.match(/^Bearer\s+(.+)$/i);
    if (!m) return res.status(401).json({ error: 'missing_token' });

    const token = m[1];

    // 🔐 Atajo: token de servicio (cron, integraciones internas)
    if (SERVICE_BEARER && token === SERVICE_BEARER) {
      req.user = { id: 0, email: null, role: 'service' };
      req.isService = true;
      return next();
    }

    // JWT estándar
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

/**
 * loadActiveBusiness
 * - Para usuarios normales: respeta pertenencia (owner/compartido).
 * - Para rol "service": toma el business **solo por id** (header/query/param) y no exige pertenencia.
 */
async function loadActiveBusiness(req, res, next) {
  try {
    // Si viene service, resolvemos el negocio por id directo
    if (req.user?.role === 'service') {
      const headerId = req.header('X-Business-Id');
      const queryId  = req.query.businessId;
      const paramId  = req.params.businessId || req.params.id;
      const bizId = Number(headerId ?? queryId ?? paramId);

      if (!Number.isFinite(bizId)) {
        return res.status(400).json({ error: 'business_id_required_for_service' });
      }

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

    // Usuarios app (no service)
    if (req.user?.role === 'app_admin') {
      return res.status(403).json({ error: 'forbidden_for_app_admin' });
    }

    const uid = req.user?.id;
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

    if (!Number.isFinite(bizId)) {
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
}

module.exports = { authRequired, loadActiveBusiness };

