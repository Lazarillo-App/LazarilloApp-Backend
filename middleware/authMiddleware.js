// middleware/authMiddleware.js
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { getEffectiveRole } = require('../services/auth/accessControl');

const SECRET = process.env.JWT_SECRET || 'dev-secret';
const SERVICE_BEARER = (process.env.SERVICE_BEARER || '').trim();

/** Requiere auth por:
 *  - Bearer <SERVICE_BEARER>  -> usuario "service" (id:0) sin chequeo de membresía
 *  - Bearer <JWT>             -> usuario normal (payload { uid, email })
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

    // Normalizar uid/id a integer
    const rawUid = payload.uid ?? payload.id ?? null;
    const uidNum = Number(rawUid);

    if (!Number.isFinite(uidNum) || uidNum <= 0) {
      return res.status(401).json({ error: 'invalid_token_payload' });
    }

    // ─── Rol de PLATAFORMA (no de negocio) ───
    // Si el JWT trae role='app_admin' (superuser de Anthropic), lo respetamos.
    // El rol de negocio se resuelve en loadActiveBusiness a partir de user_assignments.
    let platformRole = null;
    if (payload.role === 'app_admin') {
      platformRole = 'app_admin';
    } else {
      // Verificar en DB por si lo subimos después de emitir el token
      const { rows } = await pool.query(
        `SELECT role FROM app_users WHERE id = $1 LIMIT 1`,
        [uidNum]
      );
      if (rows[0]?.role === 'app_admin') platformRole = 'app_admin';
    }

    req.user = {
      id: uidNum,
      email: payload.email || null,
      role: platformRole,           // null para usuarios normales
    };

    req.isService = false;
    next();
  } catch (e) {
    console.error('authRequired error:', e);
    res.status(500).json({ error: 'internal' });
  }
}

/** Resuelve negocio activo y lo adjunta como req.businessId / req.business.
 *  Orden de resolución: X-Business-Id -> ?businessId -> :businessId|:id -> active_business_id.
 *  - Usuarios "service": sólo se verifica existencia.
 *  - Usuarios reales: se verifica acceso vía user_assignments / owner_id / herencia de org.
 *  - Adjunta req.businessRole con el rol efectivo (owner|admin|staff).
 */
async function loadActiveBusiness(req, res, next) {
  try {
    // app_admin no usa endpoints tenant — excepto /api/admin/* y /api/access/*
    if (req.user?.role === 'app_admin' && !req.isService) {
      const url = req.originalUrl || '';
      if (url.includes('/api/admin') || url.includes('/api/access')) {
        return next();
      }
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
      req.businessRole = null;
      return next();
    }

    // service: no checa membresía
    if (req.isService) {
      const { rows } = await pool.query('SELECT * FROM app_businesses WHERE id=$1 LIMIT 1', [bizId]);
      if (!rows[0]) return res.status(404).json({ error: 'business_not_found' });
      const row = rows[0];
      const props = (row.props && typeof row.props === 'object') ? row.props : {};
      if (!props.maxi) props.maxi = {};
      req.businessId = row.id;
      req.business = { ...row, props };
      req.businessRole = 'service';
      return next();
    }

    // usuario real: validar acceso vía accessControl (owner_id OR assignment OR org-inherited)
    const effectiveRole = await getEffectiveRole(uid, bizId);
    if (!effectiveRole) {
      if (['header', 'query', 'param'].includes(source)) {
        return res.status(403).json({ error: 'no_access_to_business' });
      }
      req.businessId = null;
      req.business = null;
      req.businessRole = null;
      return next();
    }

    // Cargar datos del negocio
    const { rows } = await pool.query(
      `SELECT * FROM app_businesses WHERE id=$1 LIMIT 1`,
      [bizId]
    );
    if (!rows[0]) {
      return res.status(404).json({ error: 'business_not_found' });
    }

    const row = rows[0];
    const props = (row.props && typeof row.props === 'object') ? row.props : {};
    if (!props.maxi) props.maxi = {};
    req.businessId = row.id;
    req.business = { ...row, props };
    req.businessRole = effectiveRole;   // 'owner' | 'admin' | 'staff'
    next();
  } catch (e) {
    console.error('loadActiveBusiness error:', e);
    res.status(500).json({ error: 'internal' });
  }
}

/** Middleware factory: requiere al menos cierto rol en el negocio activo.
 *  Uso:  app.use('/api/algo', authRequired, loadActiveBusiness, requireBusinessRole('admin'), handler)
 */
function requireBusinessRole(minRole = 'staff') {
  const LVL = { owner: 3, admin: 2, staff: 1, service: 99 };
  return (req, res, next) => {
    const has = LVL[req.businessRole] ?? 0;
    const need = LVL[minRole] ?? 0;
    if (has >= need) return next();
    return res.status(403).json({ error: 'forbidden', need: minRole, has: req.businessRole });
  };
}

module.exports = { authRequired, loadActiveBusiness, requireBusinessRole };