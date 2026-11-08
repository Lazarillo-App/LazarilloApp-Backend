// services/auth/permisos.js
//
// Roles a medida: un admin puede tener un rol que limita qué secciones ve y qué partes
// se ocultan adentro. Owner y staff no cambian (la vista Staff es la de siempre).
// permisos === null  → sin límites (todo lo que su rol base ya permitía).
const pool = require('../../config/db');

const SECCIONES = ['resultados', 'carga', 'recetas', 'rrhh', 'conceptos', 'medios', 'configuracion', 'conexiones'];

function normalizarRol(row) {
  if (!row) return null;
  const secciones = {};
  const src = row.secciones && typeof row.secciones === 'object' ? row.secciones : {};
  for (const s of SECCIONES) {
    if (src[s] === 'ver' || src[s] === 'editar') secciones[s] = src[s];
  }
  const ocultos = Array.isArray(row.ocultos) ? row.ocultos.filter((x) => typeof x === 'string').slice(0, 200) : [];
  return { rolId: Number(row.id), nombre: row.nombre, secciones, ocultos };
}

/** Permisos del usuario sobre el negocio, o null si no tiene límites.
 *  Admin con rol a medida → ese rol. Admin sin rol a medida → el "Administración" ajustado de
 *  la organización (o del negocio), si el dueño lo ajustó; si no, null (ve todo). */
async function getPermisos(userId, businessId) {
  if (!userId || !businessId) return null;
  const { rows } = await pool.query(
    `
    WITH biz AS (SELECT id, owner_id, organization_id FROM app_businesses WHERE id = $2)
    SELECT ua.role, ua.scope_type,
           COALESCE(cr.id, base.id) AS id, COALESCE(cr.nombre, base.nombre) AS nombre,
           COALESCE(cr.secciones, base.secciones) AS secciones, COALESCE(cr.ocultos, base.ocultos) AS ocultos,
           (cr.id IS NULL AND base.id IS NULL) AS sin_limites,
           (SELECT owner_id FROM biz) = $1 AS es_owner
      FROM user_assignments ua
      LEFT JOIN app_custom_roles cr ON cr.id = ua.custom_role_id AND cr.deleted_at IS NULL
      LEFT JOIN LATERAL (
        SELECT b.* FROM app_custom_roles b
         WHERE b.es_administracion AND b.deleted_at IS NULL
           AND (b.organization_id = (SELECT organization_id FROM biz)
             OR (b.business_id = $2 AND (SELECT organization_id FROM biz) IS NULL))
         LIMIT 1
      ) base ON ua.role = 'admin' AND cr.id IS NULL
     WHERE ua.user_id = $1 AND ua.revoked_at IS NULL
       AND ((ua.scope_type = 'business' AND ua.scope_id = $2)
         OR (ua.scope_type = 'organization' AND ua.scope_id = (SELECT organization_id FROM biz)))
    `,
    [userId, businessId]
  );
  if (!rows.length) return null;
  if (rows.some((r) => r.es_owner || r.role === 'owner')) return null;
  const admins = rows.filter((r) => r.role === 'admin');
  if (!admins.length) return null; // staff: vista de siempre
  // Un acceso admin sin límites (Administración sin ajustar) gana: ve todo.
  if (admins.some((r) => r.sin_limites)) return null;
  const elegido = admins.find((r) => r.scope_type === 'business') || admins[0];
  return normalizarRol(elegido);
}

const puedeSeccion = (permisos, seccion, modo = 'ver') => {
  if (!permisos) return true;
  const m = permisos.secciones?.[seccion];
  if (!m) return false;
  return modo === 'ver' || m === 'editar';
};

const estaOculto = (permisos, clave) => !!permisos && permisos.ocultos?.includes(clave);

/** Middleware: corta con 403 si el rol a medida no ve (o no edita) la sección. */
function requireSeccion(seccion) {
  return (req, res, next) => {
    const modo = req.method === 'GET' ? 'ver' : 'editar';
    if (puedeSeccion(req.permisos, seccion, modo)) return next();
    return res.status(403).json({ error: 'sin_permiso', seccion, modo });
  };
}

module.exports = { SECCIONES, normalizarRol, getPermisos, puedeSeccion, estaOculto, requireSeccion };
