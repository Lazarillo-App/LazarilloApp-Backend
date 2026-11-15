// middleware/verComoPersona.js
// «Ver como» una persona, exacto (Diego 15/11/2026): cuando el DUEÑO pide datos con el header
// X-Ver-Como: <id de la asignación>, las LECTURAS (GET) se resuelven como esa persona: su rol, sus
// permisos con ajustes y sus sectores (recetas, plazas…). Así el dueño ve exactamente lo que ve ella.
// · Solo GET: lo que se guarda en «Ver como» sigue quedando con el usuario del dueño (decisión 11/11).
// · Solo si quien pide es dueño del negocio activo y la asignación es de ese negocio (o su organización).
// · No toca la sesión ni el equipo (/me, /auth, /team, /roles, /superusuarios): el front tiene que
//   seguir sabiendo que el que mira es el dueño.
const pool = require('../config/db');
const { getEffectiveRole } = require('../services/auth/accessControl');
const { getPermisos } = require('../services/auth/permisos');

const EXCLUIDAS = /^\/api\/(me|auth|team|roles|superusuarios|admin)(\/|$)/;

module.exports = async function verComoPersona(req, res, next) {
  try {
    const h = Number(req.get('X-Ver-Como'));
    if (!Number.isFinite(h) || h <= 0) return next();
    if (req.method !== 'GET') return next();
    if (EXCLUIDAS.test(String(req.originalUrl || '').split('?')[0])) return next();
    if (req.businessRole !== 'owner' || !req.businessId) return next();

    const { rows } = await pool.query(
      `SELECT ua.user_id
         FROM user_assignments ua
         JOIN app_businesses b ON b.id = $2
        WHERE ua.id = $1 AND ua.revoked_at IS NULL AND ua.role IN ('admin', 'staff')
          AND ((ua.scope_type = 'business' AND ua.scope_id = b.id)
            OR (ua.scope_type = 'organization' AND ua.scope_id = b.organization_id))
        LIMIT 1`,
      [h, req.businessId]
    );
    const uid = rows[0]?.user_id;
    if (!uid) return next();
    const rol = await getEffectiveRole(uid, req.businessId);
    if (!rol || rol === 'owner') return next();

    req.verComoDueno = req.user.id;
    req.user = { ...req.user, id: Number(uid) };
    req.businessRole = rol;
    req.permisos = rol === 'admin' ? await getPermisos(uid, req.businessId) : null;
    return next();
  } catch (e) {
    console.warn('[verComoPersona]', e.message);
    return next();
  }
};
