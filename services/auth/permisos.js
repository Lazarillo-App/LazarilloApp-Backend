// services/auth/permisos.js
//
// Roles a medida: un admin puede tener un rol que limita qué secciones ve y qué partes
// se ocultan adentro. Owner y staff no cambian (la vista Staff es la de siempre).
// permisos === null  → sin límites (todo lo que su rol base ya permitía).
const pool = require('../../config/db');

const SECCIONES = ['resultados', 'carga', 'recetas', 'rrhh', 'conceptos', 'medios', 'configuracion', 'conexiones'];

// Administración POR DEFECTO del sistema (Diego 12/11/2026): los roles que se definen acá en el
// código valen para TODAS las cuentas; lo particular lo ajusta cada dueño en Roles. Es el ajuste
// que Diego armó para CONTENEDORES: edita todo, pero sin tarjetas de ventas/equilibrio/resultado,
// sin totales por rubro, sin ingresos vs egresos ni diferencia de caja y sin la pestaña Resultados.
const ADMINISTRACION_DEFAULT = Object.freeze({
  secciones: Object.freeze(Object.fromEntries(SECCIONES.map((s) => [s, 'editar']))),
  ocultos: Object.freeze(['tarjeta.ventas', 'tarjeta.equilibrio', 'tarjeta.resultado', 'tabla.totales_rubro', 'tabla.ing_egr', 'tabla.dif_caja', 'tab.resultados']),
});
const administracionDefault = () => ({ rolId: null, nombre: 'Administración', porDefecto: true,
  secciones: { ...ADMINISTRACION_DEFAULT.secciones }, ocultos: [...ADMINISTRACION_DEFAULT.ocultos] });

// ── Ajustes por persona (Diego 14/11/2026) ───────────────────────────────────────────────
// Excepciones sobre el rol, guardadas en user_assignments.permissions (jsonb, '{}' = sin ajustes):
//   { secciones: { resultados: 'ver'|'editar'|'no', … }, ocultosMas: [...], ocultosMenos: [...],
//     staff: { ver_precio: true|false, … } }
// Se guardan como DIFERENCIA con el rol: si después cambia el rol, la persona sigue con sus
// excepciones encima del rol nuevo.
function limpiarAjustes(src) {
  const o = src && typeof src === 'object' ? src : {};
  const out = {};
  const sec = {};
  for (const s of SECCIONES) {
    const v = o.secciones?.[s];
    if (v === 'ver' || v === 'editar' || v === 'no') sec[s] = v;
  }
  if (Object.keys(sec).length) out.secciones = sec;
  const lista = (x) => (Array.isArray(x) ? [...new Set(x.filter((k) => typeof k === 'string' && k.length <= 60))].slice(0, 200) : []);
  const mas = lista(o.ocultosMas);
  const menos = lista(o.ocultosMenos).filter((k) => !mas.includes(k));
  if (mas.length) out.ocultosMas = mas;
  if (menos.length) out.ocultosMenos = menos;
  const st = {};
  for (const k of STAFF_KEYS) if (typeof o.staff?.[k] === 'boolean') st[k] = o.staff[k];
  if (Object.keys(st).length) out.staff = st;
  return out;
}
const cantidadAjustes = (a) => {
  const x = limpiarAjustes(a);
  return Object.keys(x.secciones || {}).length + (x.ocultosMas || []).length + (x.ocultosMenos || []).length + Object.keys(x.staff || {}).length;
};
function aplicarAjustes(permisos, ajustes) {
  const a = limpiarAjustes(ajustes);
  if (!permisos || !cantidadAjustes(a)) return permisos;
  const secciones = { ...permisos.secciones };
  for (const [s, v] of Object.entries(a.secciones || {})) {
    if (v === 'no') delete secciones[s]; else secciones[s] = v;
  }
  const ocultos = [...new Set([...(permisos.ocultos || []), ...(a.ocultosMas || [])])].filter((k) => !(a.ocultosMenos || []).includes(k));
  return { ...permisos, secciones, ocultos, ajustes: cantidadAjustes(a) };
}

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
 *  la organización (o del negocio), si el dueño lo ajustó; si no, la Administración por defecto
 *  del sistema (ADMINISTRACION_DEFAULT). */
async function getPermisos(userId, businessId, { sinAjustes = false } = {}) {
  if (!userId || !businessId) return null;
  const { rows } = await pool.query(
    `
    WITH biz AS (SELECT id, owner_id, organization_id FROM app_businesses WHERE id = $2)
    SELECT ua.role, ua.scope_type,
           COALESCE(cr.id, base.id) AS id, COALESCE(cr.nombre, base.nombre) AS nombre,
           COALESCE(cr.secciones, base.secciones) AS secciones, COALESCE(cr.ocultos, base.ocultos) AS ocultos,
           (cr.id IS NULL AND base.id IS NULL) AS sin_limites, ua.permissions AS ajustes,
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
  const elegido = admins.find((r) => r.scope_type === 'business') || admins[0];
  const rol = elegido.sin_limites ? administracionDefault() : normalizarRol(elegido);
  return sinAjustes ? rol : aplicarAjustes(rol, elegido.ajustes);
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

// ── Staff y sus subroles (Diego 11/11/2026) ──────────────────────────────────────────────
// Qué puede hacer un Staff. Por defecto NO (clave ausente = false); el dueño habilita en Roles.
// aprobar_equipo convierte al subrol en «jefe» de sus sectores (da el OK antes del admin).
const STAFF_KEYS = ['ver_precio', 'ver_costo_pct', 'ver_objetivo', 'ver_sugerido', 'mover_agrupacion', 'ver_menu', 'aprobar_equipo'];
// El subrol que se crea solo la primera vez (se puede editar o borrar).
const JEFE_DEFAULT = { ver_precio: true, ver_costo_pct: true, aprobar_equipo: true };

function limpiarStaff(src, { base = false } = {}) {
  const out = {};
  const o = src && typeof src === 'object' ? src : {};
  for (const k of STAFF_KEYS) if (o[k] === true) out[k] = true;
  if (base) delete out.aprobar_equipo; // el Staff sin subrol nunca es jefe
  return out;
}

/** Permisos de un Staff en el negocio: { subrolId, subrol, permisos } o null si no es staff.
 *  Base (es_staff_base de su organización/negocio) + su subrol (custom_role_id con base staff);
 *  el legado user_assignments.subrol = 'jefe' cuenta como JEFE_DEFAULT. */
async function getStaffPermisos(userId, businessId, { sinAjustes = false } = {}) {
  if (!userId || !businessId) return null;
  const { rows } = await pool.query(
    `
    WITH biz AS (SELECT id, organization_id FROM app_businesses WHERE id = $2)
    SELECT ua.subrol, ua.permissions AS ajustes, cr.id AS subrol_id, cr.nombre AS subrol_nombre, cr.permisos_staff AS sub_perm,
           (SELECT b.permisos_staff FROM app_custom_roles b
             WHERE b.es_staff_base AND b.deleted_at IS NULL
               AND (b.organization_id = (SELECT organization_id FROM biz)
                 OR (b.business_id = $2 AND (SELECT organization_id FROM biz) IS NULL))
             LIMIT 1) AS base_perm
      FROM user_assignments ua
      LEFT JOIN app_custom_roles cr ON cr.id = ua.custom_role_id AND cr.deleted_at IS NULL AND cr.base_role = 'staff'
     WHERE ua.user_id = $1 AND ua.revoked_at IS NULL AND ua.role = 'staff'
       AND ua.scope_type = 'business' AND ua.scope_id = $2
     LIMIT 1
    `,
    [userId, businessId]
  );
  if (!rows.length) return null;
  const r = rows[0];
  const permisos = { ...limpiarStaff(r.base_perm, { base: true }) };
  if (r.subrol_id) Object.assign(permisos, limpiarStaff(r.sub_perm));
  else if (r.subrol === 'jefe') Object.assign(permisos, JEFE_DEFAULT);
  // Ajustes solo para esta persona (true habilita, false saca).
  for (const [k, v] of Object.entries(sinAjustes ? {} : (limpiarAjustes(r.ajustes).staff || {}))) {
    if (v) permisos[k] = true; else delete permisos[k];
  }
  return {
    subrolId: r.subrol_id ? Number(r.subrol_id) : null,
    subrol: r.subrol_id ? r.subrol_nombre : (r.subrol === 'jefe' ? 'Jefe de cocina' : null),
    permisos,
  };
}

// SQL: la asignación (alias a) es de un jefe = subrol con aprobar_equipo (o el legado subrol='jefe').
const sqlEsJefe = (a) => `(${a}.role = 'staff' AND (${a}.subrol = 'jefe' OR EXISTS (
  SELECT 1 FROM app_custom_roles xj WHERE xj.id = ${a}.custom_role_id AND xj.deleted_at IS NULL
     AND xj.base_role = 'staff' AND COALESCE((xj.permisos_staff->>'aprobar_equipo')::boolean, FALSE))))`;

module.exports = { SECCIONES, normalizarRol, ADMINISTRACION_DEFAULT, administracionDefault, getPermisos, puedeSeccion, estaOculto, requireSeccion,
  STAFF_KEYS, JEFE_DEFAULT, limpiarStaff, getStaffPermisos, sqlEsJefe, limpiarAjustes, aplicarAjustes, cantidadAjustes };
