// middleware/auth.js
const jwt  = require('jsonwebtoken');
const pool = require('../config/db');

const SECRET = process.env.JWT_SECRET || 'dev-secret';
const SERVICE_BEARER = (process.env.SERVICE_BEARER || '').trim();

/**
 * Auth:
 * - Bearer <SERVICE_BEARER> -> usuario "service" (id:0), sin chequeo de membresía
 * - Bearer <JWT>            -> usuario normal/admin (payload { id|uid, email, role })
 */
async function authRequired(req, res, next) {
  try {
    const auth = req.headers.authorization || '';
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (!m) return res.status(401).json({ error: 'missing_token' });

    const token = m[1].trim();

    // Token de servicio (no-JWT)
    if (SERVICE_BEARER && token === SERVICE_BEARER) {
      req.user = { id: 0, email: null, role: 'service' };
      req.isService = true;
      return next();
    }

    // JWT normal
    let payload;
    try { payload = jwt.verify(token, SECRET); }
    catch { return res.status(401).json({ error: 'invalid_token' }); }

    // Soportar id o uid
    const uid = payload.uid ?? payload.id;
    req.user = { id: uid, email: payload.email ?? null, role: payload.role ?? null };
    req.isService = false;
    next();
  } catch (e) {
    console.error('authRequired error:', e);
    res.status(500).json({ error: 'internal' });
  }
}

/**
 * Resuelve negocio activo:
 * Prioridad: header X-Business-Id -> query ?businessId -> params :businessId|:id -> active_business_id
 * - "service" y "app_admin" sólo verifican EXISTENCIA del business (sin membresía).
 * - Usuarios normales: validan pertenencia (owner o vínculo).
 *
 * Expone: req.businessId, req.business_id, req.business y setea req.user.active_business_id
 */
async function loadActiveBusiness(req, res, next) {
  try {
    const uid = req.user?.id ?? null;

    const headerId = req.get('X-Business-Id');
    const queryId  = req.query?.businessId;
    const paramId  = req.params?.businessId ?? req.params?.id;

    let bizId = null;
    if (headerId)      bizId = Number(headerId);
    else if (queryId)  bizId = Number(queryId);
    else if (paramId)  bizId = Number(paramId);
    else {
      // fallback a active_business_id (sólo usuarios normales; para service/app_admin no tiene sentido)
      if (!req.isService && req.user?.role !== 'app_admin' && Number.isFinite(uid)) {
        const { rows } = await pool.query(
          'SELECT active_business_id FROM app_users WHERE id=$1 LIMIT 1',
          [uid]
        );
        bizId = Number(rows[0]?.active_business_id ?? NaN);
      }
    }

    if (!Number.isFinite(bizId)) {
      req.businessId = null;
      req.business_id = null;
      req.business = null;
      return res.status(400).json({ error: 'missing_business', message: 'Falta businessId' });
    }

    // Obtención del negocio
    const { rows } = await pool.query('SELECT * FROM app_businesses WHERE id=$1 LIMIT 1', [bizId]);
    if (!rows[0]) return res.status(404).json({ error: 'business_not_found' });

    // app_admin y service -> NO chequean membresía
    if (req.isService || req.user?.role === 'app_admin') {
      const row = rows[0];
      const props = (row.props && typeof row.props === 'object') ? row.props : {};
      if (!props.maxi) props.maxi = {};
      req.user.active_business_id = bizId;
      req.businessId = bizId;
      req.business_id = bizId;         // compat
      req.business = { ...row, props };
      return next();
    }

    // Usuario normal -> validar pertenencia
    // Ajusta el nombre de la tabla si en tu esquema es 'app_user_business' o 'user_businesses'
    const { rows: mRows } = await pool.query(`
      SELECT 1
      FROM app_user_businesses ub
      WHERE ub.user_id = $1 AND ub.business_id = $2
      LIMIT 1
    `, [uid, bizId]);

    const { rows: ownerRows } = await pool.query(
      `SELECT 1 FROM app_businesses WHERE id=$1 AND owner_id=$2 LIMIT 1`,
      [bizId, uid]
    );

    if (!mRows.length && !ownerRows.length) {
      return res.status(403).json({ error: 'no_access_to_business' });
    }

    const row = rows[0];
    const props = (row.props && typeof row.props === 'object') ? row.props : {};
    if (!props.maxi) props.maxi = {};
    req.user.active_business_id = bizId;
    req.businessId = bizId;
    req.business_id = bizId;           // compat
    req.business = { ...row, props };
    next();
  } catch (e) {
    console.error('loadActiveBusiness error:', e);
    res.status(500).json({ error: 'internal' });
  }
}

module.exports = { authRequired, loadActiveBusiness };
