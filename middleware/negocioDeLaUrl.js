// middleware/negocioDeLaUrl.js
//
// En /api/businesses/:id/… el negocio es el de la URL, no el activo.
//
// loadActiveBusiness resuelve el negocio por X-Business-Id ANTES que por :id, y el front manda
// siempre el negocio activo en ese header. Entonces al guardar OTRO negocio (el recién creado en
// el alta, o uno editado desde la lista) el logo, los colores y los datos se escribían en el
// negocio activo (usuaria 16/11/2026: «subí el logo dos veces y vuelve al azul y sin logo»).
//
// Si :id es otro negocio, se verifica el acceso a ESE (getEffectiveRole) y se cargan
// req.businessId / req.business / req.businessRole / req.permisos de ese. Si es el mismo, no cambia nada.
'use strict';

const pool = require('../config/db');
const { getEffectiveRole } = require('../services/auth/accessControl');
const { getPermisos } = require('../services/auth/permisos');

async function negocioDeLaUrl(req, res, next) {
  try {
    const id = Number(req.params?.id);
    if (!Number.isInteger(id) || id <= 0 || id === Number(req.businessId)) return next();
    if (req.isService) return next();
    const uid = req.user?.id;
    if (!uid) return res.status(401).json({ error: 'unauthorized' });

    const rol = await getEffectiveRole(uid, id);
    if (!rol) return res.status(403).json({ error: 'no_access_to_business' });

    const { rows } = await pool.query('SELECT * FROM app_businesses WHERE id = $1 LIMIT 1', [id]);
    if (!rows[0]) return res.status(404).json({ error: 'business_not_found' });
    const props = rows[0].props && typeof rows[0].props === 'object' ? rows[0].props : {};
    if (!props.maxi) props.maxi = {};

    req.businessId = id;
    req.business = { ...rows[0], props };
    req.businessRole = rol;
    req.permisos = null;
    if (rol === 'admin') {
      try { req.permisos = await getPermisos(uid, id); } catch (e) { console.warn('[negocioDeLaUrl] permisos', e.message); }
    }
    return next();
  } catch (e) {
    console.error('[negocioDeLaUrl]', e);
    return res.status(500).json({ error: 'internal' });
  }
}

module.exports = negocioDeLaUrl;
