// middleware/requireBusinessAccess.js
//
// Middleware de Express usado como router.param('id', ...) o como middleware
// en rutas /api/businesses/:id/... que valida que el usuario tenga ALGÚN
// acceso al negocio (owner_id legacy, user_businesses legacy, user_assignments
// con scope business, o user_assignments con scope organization que herede).
//
// Setea req.business y req.businessRole.

const pool = require('../config/db');
const { getEffectiveRole } = require('../services/auth/accessControl');

/**
 * Versión como router.param: lee req.params[param] como businessId.
 * No usar como middleware estándar; usar `requireBusinessAccess` abajo para eso.
 */
async function requireBusinessAccessParam(req, res, next, value, name) {
  try {
    const bizId = Number(value);
    if (!Number.isFinite(bizId) || bizId <= 0) {
      return res.status(400).json({ error: 'invalid_business_id' });
    }

    const uid = req.user?.id ?? null;

    // service (token de servicio): no chequear membresía, solo existencia
    if (req.isService) {
      const { rows } = await pool.query('SELECT * FROM app_businesses WHERE id=$1 LIMIT 1', [bizId]);
      if (!rows[0]) return res.status(404).json({ error: 'business_not_found' });
      const row = rows[0];
      const props = (row.props && typeof row.props === 'object') ? row.props : {};
      if (!props.maxi) props.maxi = {};
      req.business = { ...row, props };
      req.businessId = row.id;
      req.businessRole = 'service';
      return next();
    }

    if (!uid) return res.status(401).json({ error: 'unauthorized' });

    // Resolver rol efectivo (cubre owner_id, assignment business, assignment org-heredada)
    const effectiveRole = await getEffectiveRole(uid, bizId);
    if (!effectiveRole) {
      return res.status(403).json({ error: 'no_access_to_business' });
    }

    const { rows } = await pool.query('SELECT * FROM app_businesses WHERE id=$1 LIMIT 1', [bizId]);
    if (!rows[0]) return res.status(404).json({ error: 'business_not_found' });

    const row = rows[0];
    const props = (row.props && typeof row.props === 'object') ? row.props : {};
    if (!props.maxi) props.maxi = {};
    req.business = { ...row, props };
    req.businessId = row.id;
    req.businessRole = effectiveRole;
    next();
  } catch (e) {
    console.error('[requireBusinessAccessParam] error:', e);
    res.status(500).json({ error: 'internal' });
  }
}

/**
 * Versión como middleware estándar: usa req.params.businessId, ?businessId, o X-Business-Id.
 */
async function requireBusinessAccess(req, res, next) {
  try {
    const bizId = Number(
      req.params?.businessId ||
      req.params?.id ||
      req.query?.businessId ||
      req.header('X-Business-Id')
    );
    if (!Number.isFinite(bizId) || bizId <= 0) {
      return res.status(400).json({ error: 'invalid_business_id' });
    }

    const uid = req.user?.id ?? null;

    if (req.isService) {
      const { rows } = await pool.query('SELECT * FROM app_businesses WHERE id=$1 LIMIT 1', [bizId]);
      if (!rows[0]) return res.status(404).json({ error: 'business_not_found' });
      const row = rows[0];
      const props = (row.props && typeof row.props === 'object') ? row.props : {};
      if (!props.maxi) props.maxi = {};
      req.business = { ...row, props };
      req.businessId = row.id;
      req.businessRole = 'service';
      return next();
    }

    if (!uid) return res.status(401).json({ error: 'unauthorized' });

    const effectiveRole = await getEffectiveRole(uid, bizId);
    if (!effectiveRole) {
      return res.status(403).json({ error: 'no_access_to_business' });
    }

    const { rows } = await pool.query('SELECT * FROM app_businesses WHERE id=$1 LIMIT 1', [bizId]);
    if (!rows[0]) return res.status(404).json({ error: 'business_not_found' });

    const row = rows[0];
    const props = (row.props && typeof row.props === 'object') ? row.props : {};
    if (!props.maxi) props.maxi = {};
    req.business = { ...row, props };
    req.businessId = row.id;
    req.businessRole = effectiveRole;
    next();
  } catch (e) {
    console.error('[requireBusinessAccess] error:', e);
    res.status(500).json({ error: 'internal' });
  }
}

module.exports = {
  requireBusinessAccess,
  requireBusinessAccessParam,
};