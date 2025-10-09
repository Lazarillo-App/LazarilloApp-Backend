// middleware/business.js
const pool = require('../config/db');

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Resuelve el negocio activo y valida pertenencia (owner o miembro).
 * Deja `req.businessId` y `req.business` listos para los controladores.
 *
 * Prioridad de origen:
 *   1) Header:  X-Business-Id (o x-business-id)
 *   2) Query:   ?businessId=...
 *   3) Params:  /businesses/:id  o  /:businessId
 *   4) Activo guardado en app_users.active_business_id
 */
async function loadActiveBusiness(req, res, next) {
  try {
    const uid = req.user?.id;
    if (!uid) return res.status(401).json({ error: 'unauthorized' });

    // prioridad: header -> param -> query -> activo del usuario
    const hId = req.header('X-Business-Id');
    const pId = req.params.businessId || req.params.id;
    const qId = req.query.businessId;

    let bizId = Number(hId ?? pId ?? qId);
    if (!Number.isFinite(bizId)) {
      const { rows } = await pool.query(
        'SELECT active_business_id FROM app_users WHERE id=$1',
        [uid]
      );
      bizId = Number(rows[0]?.active_business_id);
    }
    if (!Number.isFinite(bizId)) {
      return res.status(404).json({ error: 'no_active_business' });
    }

    // dueño O miembro
    const { rows } = await pool.query(
      `SELECT b.*
         FROM app_businesses b
         LEFT JOIN user_businesses ub
           ON ub.business_id = b.id AND ub.user_id = $2
        WHERE b.id = $1 AND (b.owner_id = $2 OR ub.user_id IS NOT NULL)
        LIMIT 1`,
      [bizId, uid]
    );
    const biz = rows[0];
    if (!biz) return res.status(403).json({ error: 'no_access_to_business' });

    // normalizar props
    const props = (biz.props && typeof biz.props === 'object') ? biz.props : {};
    if (!props.maxi) props.maxi = {};

    req.businessId = biz.id;       // <— muchos controllers leen esto
    req.bizId = biz.id;            // <— compat
    req.business = { ...biz, props };
    next();
  } catch (e) {
    console.error('loadActiveBusiness error:', e);
    res.status(500).json({ error: 'internal' });
  }
};

/** Úsalo si querés forzar que exista negocio resuelto antes de entrar */
function requireBusiness(req, res, next) {
  if (!req.businessId) return res.status(404).json({ error: 'no_active_business' });
  next();
}

module.exports = { loadActiveBusiness, requireBusiness };
