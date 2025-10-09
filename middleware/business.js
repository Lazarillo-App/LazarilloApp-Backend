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

    // 1) resolver businessId
    const h = req.get('X-Business-Id') || req.get('x-business-id');
    const q = req.query?.businessId;
    const p = req.params?.businessId || req.params?.id;

    let source = 'none';
    let businessId =
      (h && toNum(h)) || (q && toNum(q)) || (p && toNum(p)) || null;

    if (!businessId) {
      const { rows } = await pool.query(
        'SELECT active_business_id FROM app_users WHERE id=$1',
        [uid],
      );
      businessId = toNum(rows[0]?.active_business_id);
      source = 'active';
    } else {
      source = h ? 'header' : q ? 'query' : 'param';
    }

    if (!businessId) {
      // Este middleware lo usamos sólo en rutas que requieren negocio,
      // así que devolvemos 404/semantic “no active”.
      return res.status(404).json({ error: 'no_active_business' });
    }

    // 2) validar acceso (owner o miembro)
    const { rows } = await pool.query(
      `
      SELECT b.*
        FROM app_businesses b
        LEFT JOIN user_businesses ub ON ub.business_id = b.id
       WHERE b.id = $1 AND (b.owner_id = $2 OR ub.user_id = $2)
       LIMIT 1
      `,
      [businessId, uid],
    );

    const row = rows[0];
    if (!row) {
      // Si lo eligieron explícitamente y no pertenece → 403,
      // si vino por "active" pero ya no pertenece → 404 para resetear en front.
      return res
        .status(source === 'active' ? 404 : 403)
        .json({ error: source === 'active' ? 'no_active_business' : 'no_access_to_business' });
    }

    // 3) normalizar props (siempre objeto; maxi también)
    const props = row.props && typeof row.props === 'object' ? row.props : {};
    if (!props.maxi || typeof props.maxi !== 'object') props.maxi = {};
    if (!props.maxi.email && props.Maxi?.email) props.maxi = { ...props.maxi, ...props.Maxi };

    req.businessId = row.id;
    req.business   = { ...row, props };
    next();
  } catch (e) {
    console.error('loadActiveBusiness error:', e);
    res.status(500).json({ error: 'internal' });
  }
}

/** Úsalo si querés forzar que exista negocio resuelto antes de entrar */
function requireBusiness(req, res, next) {
  if (!req.businessId) return res.status(404).json({ error: 'no_active_business' });
  next();
}

module.exports = { loadActiveBusiness, requireBusiness };
