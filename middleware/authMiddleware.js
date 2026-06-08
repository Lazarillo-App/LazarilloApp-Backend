// middleware/authMiddleware.js
const jwt = require('jsonwebtoken');
const pool = require('../config/db');

const SECRET = process.env.JWT_SECRET || 'dev-secret';
const SERVICE_BEARER = (process.env.SERVICE_BEARER || '').trim();

/** Requiere auth por:
 *  - Bearer <SERVICE_BEARER>  -> usuario “service” (id:0) sin chequeo de membresía
 *  - Bearer <JWT>             -> usuario normal (payload { uid, email, role })
 */
async function authRequired(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    const m = h.match(/^Bearer\s+(.+)$/i);
    if (!m) return res.status(401).json({ error: 'missing_token' });

    const token = m[1].trim();

    // token de servicio (no-JWT)
    if (SERVICE_BEARER && token === SERVICE_BEARER) {
      req.user = { id: 0, email: null, role: 'service' };
      req.isService = true;
      return next();
    }

    // caso JWT normal
    let payload;
    try {
      payload = jwt.verify(token, SECRET);
    } catch {
      return res.status(401).json({ error: 'invalid_token' });
    }

    // ✅ Normalizar uid/id a integer
    const rawUid = payload.uid ?? payload.id ?? null;
    const uidNum = Number(rawUid);

    if (!Number.isFinite(uidNum) || uidNum <= 0) {
      return res.status(401).json({ error: 'invalid_token_payload' });
    }

    req.user = {
      id: uidNum,
      email: payload.email || null,
      role: payload.role || null,
    };

    req.isService = false;
    next();
  } catch (e) {
    console.error('authRequired error:', e);
    res.status(500).json({ error: 'internal' });
  }
}

/** Resuelve negocio activo y lo adjunta como req.businessId / req.business.
 *  Orden de resolución: X-Business-Id -> ?businessId -> :businessId|:id -> active_business_id (usuario real).
 *  - Usuarios “service”: sólo se verifica existencia del business (no membresía).
 *  - Usuarios reales: se verifica owner o vínculo en user_businesses.
 */
async function loadActiveBusiness(req, res, next) {
  try {
    // Los app_admin no usan endpoints tenant (a menos que también vengan como “service”)
    if (req.user?.role === 'app_admin' && !req.isService) {
      return res.status(403).json({ error: 'forbidden_for_app_admin' });
    }

    const uid = req.user?.id ?? null;
    const headerId = req.header('X-Business-Id');
    const queryId = req.query?.businessId;
    const paramId = req.params?.businessId || req.params?.id;

    let source = 'none';
    let bizId = null;

    if (headerId) { bizId = Number(headerId); source = 'header'; }
    else if (queryId) { bizId = Number(queryId); source = 'query'; }
    else if (paramId) { bizId = Number(paramId); source = 'param'; }
    else if (!req.isService) {
      // sólo usuarios reales: usar active_business_id
      const { rows } = await pool.query(
        'SELECT active_business_id FROM app_users WHERE id=$1 LIMIT 1',
        [uid]
      );
      bizId = Number(rows[0]?.active_business_id ?? NaN);
      source = 'active';
    }

    if (!Number.isFinite(bizId)) {
      req.businessId = null;
      req.business = null;
      return next();
    }

    // “service”: no checa membresía, sólo existencia
    if (req.isService) {
      const { rows } = await pool.query('SELECT * FROM app_businesses WHERE id=$1 LIMIT 1', [bizId]);
      if (!rows[0]) return res.status(404).json({ error: 'business_not_found' });
      const row = rows[0];
      const props = (row.props && typeof row.props === 'object') ? row.props : {};
      if (!props.maxi) props.maxi = {};
      req.businessId = row.id;
      req.business = { ...row, props };
      return next();
    }

    // usuario real: validar owner o membresía
    const { rows } = await pool.query(`
      SELECT b.*
        FROM app_businesses b
        LEFT JOIN user_businesses ub ON ub.business_id=b.id AND ub.user_id=$2
       WHERE b.id=$1 AND (b.owner_id=$2 OR ub.user_id IS NOT NULL)
       LIMIT 1
    `, [bizId, uid]);

    if (!rows[0]) {
      if (['header', 'query', 'param'].includes(source)) {
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
    req.business = { ...row, props };
    next();
  } catch (e) {
    console.error('loadActiveBusiness error:', e);
    res.status(500).json({ error: 'internal' });
  }
}

module.exports = { authRequired, loadActiveBusiness };