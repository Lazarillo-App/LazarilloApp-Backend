// controllers/rolesController.js
//
// Roles a medida del negocio activo (viven en su organización, o en el negocio si no
// tiene). Solo el dueño los crea, edita o borra. Se apoyan en el rol admin: Dueño y
// Staff son fijos y no pasan por acá.
const pool = require('../config/db');
const { normalizarRol, SECCIONES, limpiarStaff, JEFE_DEFAULT } = require('../services/auth/permisos');

const scopeDe = (req) => {
  const orgId = Number(req.business?.organization_id);
  return Number.isFinite(orgId) && orgId > 0
    ? { col: 'organization_id', id: orgId }
    : { col: 'business_id', id: Number(req.businessId) };
};

const soloDuenio = (req, res) => {
  if (req.businessRole === 'owner') return true;
  res.status(403).json({ ok: false, error: 'only_owner' });
  return false;
};

function limpiar(body = {}) {
  const nombre = String(body.nombre || '').trim().slice(0, 60);
  const secciones = {};
  const src = body.secciones && typeof body.secciones === 'object' ? body.secciones : {};
  for (const s of SECCIONES) if (src[s] === 'ver' || src[s] === 'editar') secciones[s] = src[s];
  const ocultos = Array.isArray(body.ocultos)
    ? [...new Set(body.ocultos.filter((x) => typeof x === 'string' && x.length <= 60))].slice(0, 200)
    : [];
  return { nombre, secciones, ocultos };
}
const RESERVADOS = new Set(['dueño', 'dueno', 'administración', 'administracion', 'staff']);
const reservado = (nombre) => RESERVADOS.has(nombre.toLowerCase());

async function listar(scope) {
  const { rows } = await pool.query(
    `SELECT cr.*,
            (SELECT COUNT(DISTINCT ua.user_id)::int FROM user_assignments ua
              WHERE ua.custom_role_id = cr.id AND ua.revoked_at IS NULL AND ua.role = 'admin') AS personas
       FROM app_custom_roles cr
      WHERE cr.${scope.col} = $1 AND cr.deleted_at IS NULL AND NOT cr.es_administracion
        AND COALESCE(cr.base_role, 'admin') = 'admin' AND NOT cr.es_staff_base
      ORDER BY cr.nombre`,
    [scope.id]
  );
  return rows.map((r) => ({ ...normalizarRol(r), id: Number(r.id), personas: r.personas }));
}

// Administración ajustada (null = ve todo) + cuántos admins la usan (los que no tienen rol a medida).
async function administracionDe(scope) {
  const { rows } = await pool.query(
    `SELECT * FROM app_custom_roles WHERE ${scope.col} = $1 AND es_administracion AND deleted_at IS NULL LIMIT 1`,
    [scope.id]
  );
  const scopeAsig = scope.col === 'organization_id'
    ? `((ua.scope_type = 'organization' AND ua.scope_id = $1)
        OR (ua.scope_type = 'business' AND ua.scope_id IN (SELECT id FROM app_businesses WHERE organization_id = $1)))`
    : `(ua.scope_type = 'business' AND ua.scope_id = $1)`;
  const { rows: n } = await pool.query(
    `SELECT COUNT(DISTINCT ua.user_id)::int AS n FROM user_assignments ua
      WHERE ua.role = 'admin' AND ua.revoked_at IS NULL AND ua.custom_role_id IS NULL AND ${scopeAsig}`,
    [scope.id]
  );
  const personas = n[0]?.n ?? 0;
  return rows[0] ? { ...normalizarRol(rows[0]), id: 'admin', ajustada: true, personas } : { id: 'admin', ajustada: false, personas };
}

// ── Staff y sus subroles (Diego 11/11/2026) ──────────────────────────────────────────────
// La primera vez se crea «Jefe de cocina» (OK al equipo + precio + % de costo). Si después lo
// borran no vuelve (cuenta cualquier subrol que haya existido, borrado o no).
async function staffDe(scope) {
  const { rows: alguna } = await pool.query(
    `SELECT 1 FROM app_custom_roles WHERE ${scope.col} = $1 AND base_role = 'staff' AND NOT es_staff_base LIMIT 1`, [scope.id]);
  if (!alguna.length) {
    await pool.query(
      `INSERT INTO app_custom_roles (${scope.col}, nombre, base_role, permisos_staff) VALUES ($1, 'Jefe de cocina', 'staff', $2::jsonb)`,
      [scope.id, JSON.stringify(JEFE_DEFAULT)]);
  }
  const { rows: base } = await pool.query(
    `SELECT permisos_staff FROM app_custom_roles WHERE ${scope.col} = $1 AND es_staff_base AND deleted_at IS NULL LIMIT 1`, [scope.id]);
  const { rows } = await pool.query(
    `SELECT cr.id, cr.nombre, cr.permisos_staff,
            (SELECT COUNT(DISTINCT ua.user_id)::int FROM user_assignments ua
              WHERE ua.custom_role_id = cr.id AND ua.revoked_at IS NULL AND ua.role = 'staff') AS personas
       FROM app_custom_roles cr
      WHERE cr.${scope.col} = $1 AND cr.deleted_at IS NULL AND cr.base_role = 'staff' AND NOT cr.es_staff_base
      ORDER BY cr.created_at, cr.id`, [scope.id]);
  return {
    base: limpiarStaff(base[0]?.permisos_staff, { base: true }),
    subroles: rows.map((r) => ({ id: Number(r.id), nombre: r.nombre, permisos: limpiarStaff(r.permisos_staff), personas: r.personas })),
  };
}

exports.list = async (req, res, next) => {
  try {
    if (!['owner', 'admin'].includes(req.businessRole)) return res.status(403).json({ ok: false, error: 'forbidden' });
    const scope = scopeDe(req);
    res.json({ ok: true, roles: await listar(scope), administracion: await administracionDe(scope), staff: await staffDe(scope) });
  } catch (e) { next(e); }
};

// POST /api/roles/staff — subrol nuevo (dueño o admin; nace sin permisos extra).
exports.createStaff = async (req, res, next) => {
  try {
    if (!['owner', 'admin'].includes(req.businessRole)) return res.status(403).json({ ok: false, error: 'forbidden' });
    const nombre = String(req.body?.nombre || '').trim().slice(0, 60);
    if (!nombre) return res.status(400).json({ ok: false, error: 'nombre_requerido' });
    if (reservado(nombre)) return res.status(409).json({ ok: false, error: 'nombre_reservado' });
    const scope = scopeDe(req);
    const { rows: dup } = await pool.query(
      `SELECT 1 FROM app_custom_roles WHERE ${scope.col} = $1 AND deleted_at IS NULL AND NOT es_administracion AND NOT es_staff_base AND LOWER(nombre) = LOWER($2)`,
      [scope.id, nombre]);
    if (dup.length) return res.status(409).json({ ok: false, error: 'nombre_repetido' });
    const permisos = limpiarStaff(req.body?.permisos);
    const { rows } = await pool.query(
      `INSERT INTO app_custom_roles (${scope.col}, nombre, base_role, permisos_staff, created_by) VALUES ($1, $2, 'staff', $3::jsonb, $4) RETURNING id`,
      [scope.id, nombre, JSON.stringify(permisos), req.user?.id ?? null]);
    res.status(201).json({ ok: true, subrol: { id: Number(rows[0].id), nombre, permisos, personas: 0 } });
  } catch (e) { next(e); }
};

// PUT /api/roles/staff/base — lo que puede el Staff sin subrol (solo el dueño).
exports.setStaffBase = async (req, res, next) => {
  try {
    if (!soloDuenio(req, res)) return;
    const scope = scopeDe(req);
    const permisos = limpiarStaff(req.body?.permisos, { base: true });
    const { rowCount } = await pool.query(
      `UPDATE app_custom_roles SET permisos_staff = $1::jsonb, updated_at = NOW() WHERE ${scope.col} = $2 AND es_staff_base AND deleted_at IS NULL`,
      [JSON.stringify(permisos), scope.id]);
    if (!rowCount) {
      await pool.query(
        `INSERT INTO app_custom_roles (${scope.col}, nombre, base_role, es_staff_base, permisos_staff, created_by) VALUES ($1, 'Staff', 'staff', TRUE, $2::jsonb, $3)`,
        [scope.id, JSON.stringify(permisos), req.user?.id ?? null]);
    }
    res.json({ ok: true, staff: await staffDe(scope) });
  } catch (e) { next(e); }
};

// PUT /api/roles/staff/:id — nombre y permisos de un subrol (solo el dueño).
exports.updateStaff = async (req, res, next) => {
  try {
    if (!soloDuenio(req, res)) return;
    const id = Number(req.params.id);
    const nombre = String(req.body?.nombre || '').trim().slice(0, 60);
    if (!nombre) return res.status(400).json({ ok: false, error: 'nombre_requerido' });
    if (reservado(nombre)) return res.status(409).json({ ok: false, error: 'nombre_reservado' });
    const scope = scopeDe(req);
    const { rows: dup } = await pool.query(
      `SELECT 1 FROM app_custom_roles WHERE ${scope.col} = $1 AND deleted_at IS NULL AND NOT es_administracion AND NOT es_staff_base AND LOWER(nombre) = LOWER($2) AND id <> $3`,
      [scope.id, nombre, id]);
    if (dup.length) return res.status(409).json({ ok: false, error: 'nombre_repetido' });
    const permisos = limpiarStaff(req.body?.permisos);
    const { rowCount } = await pool.query(
      `UPDATE app_custom_roles SET nombre = $1, permisos_staff = $2::jsonb, updated_at = NOW()
        WHERE id = $3 AND ${scope.col} = $4 AND deleted_at IS NULL AND base_role = 'staff' AND NOT es_staff_base`,
      [nombre, JSON.stringify(permisos), id, scope.id]);
    if (!rowCount) return res.status(404).json({ ok: false, error: 'not_found' });
    res.json({ ok: true, staff: await staffDe(scope) });
  } catch (e) { next(e); }
};

exports.create = async (req, res, next) => {
  try {
    if (!soloDuenio(req, res)) return;
    const r = limpiar(req.body);
    if (!r.nombre) return res.status(400).json({ ok: false, error: 'nombre_requerido' });
    if (reservado(r.nombre)) return res.status(409).json({ ok: false, error: 'nombre_reservado' });
    const scope = scopeDe(req);
    const { rows: dup } = await pool.query(
      `SELECT 1 FROM app_custom_roles WHERE ${scope.col} = $1 AND deleted_at IS NULL AND NOT es_administracion AND LOWER(nombre) = LOWER($2)`,
      [scope.id, r.nombre]
    );
    if (dup.length) return res.status(409).json({ ok: false, error: 'nombre_repetido' });
    const { rows } = await pool.query(
      `INSERT INTO app_custom_roles (${scope.col}, nombre, secciones, ocultos, created_by)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5) RETURNING *`,
      [scope.id, r.nombre, JSON.stringify(r.secciones), JSON.stringify(r.ocultos), req.user?.id ?? null]
    );
    res.status(201).json({ ok: true, rol: { ...normalizarRol(rows[0]), id: Number(rows[0].id), personas: 0 } });
  } catch (e) { next(e); }
};

exports.update = async (req, res, next) => {
  try {
    if (!soloDuenio(req, res)) return;
    const id = Number(req.params.id);
    const r = limpiar(req.body);
    if (!r.nombre) return res.status(400).json({ ok: false, error: 'nombre_requerido' });
    if (reservado(r.nombre)) return res.status(409).json({ ok: false, error: 'nombre_reservado' });
    const scope = scopeDe(req);
    const { rows: dup } = await pool.query(
      `SELECT 1 FROM app_custom_roles WHERE ${scope.col} = $1 AND deleted_at IS NULL AND LOWER(nombre) = LOWER($2) AND id <> $3`,
      [scope.id, r.nombre, id]
    );
    if (dup.length) return res.status(409).json({ ok: false, error: 'nombre_repetido' });
    const { rows } = await pool.query(
      `UPDATE app_custom_roles SET nombre = $1, secciones = $2::jsonb, ocultos = $3::jsonb, updated_at = NOW()
        WHERE id = $4 AND ${scope.col} = $5 AND deleted_at IS NULL AND NOT es_administracion AND COALESCE(base_role, 'admin') = 'admin' RETURNING *`,
      [r.nombre, JSON.stringify(r.secciones), JSON.stringify(r.ocultos), id, scope.id]
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: 'not_found' });
    res.json({ ok: true, rol: { ...normalizarRol(rows[0]), id } });
  } catch (e) { next(e); }
};

// PUT /api/roles/administracion — ajusta qué ve Administración (los admins sin rol a medida).
exports.setAdministracion = async (req, res, next) => {
  try {
    if (!soloDuenio(req, res)) return;
    const r = limpiar({ ...req.body, nombre: 'Administración' });
    const scope = scopeDe(req);
    const { rowCount } = await pool.query(
      `UPDATE app_custom_roles SET secciones = $1::jsonb, ocultos = $2::jsonb, updated_at = NOW()
        WHERE ${scope.col} = $3 AND es_administracion AND deleted_at IS NULL`,
      [JSON.stringify(r.secciones), JSON.stringify(r.ocultos), scope.id]
    );
    if (!rowCount) {
      await pool.query(
        `INSERT INTO app_custom_roles (${scope.col}, nombre, secciones, ocultos, created_by, es_administracion)
         VALUES ($1, 'Administración', $2::jsonb, $3::jsonb, $4, TRUE)`,
        [scope.id, JSON.stringify(r.secciones), JSON.stringify(r.ocultos), req.user?.id ?? null]
      );
    }
    res.json({ ok: true, administracion: await administracionDe(scope) });
  } catch (e) { next(e); }
};

// DELETE /api/roles/administracion — vuelve a "ve todo".
exports.resetAdministracion = async (req, res, next) => {
  try {
    if (!soloDuenio(req, res)) return;
    const scope = scopeDe(req);
    await pool.query(
      `UPDATE app_custom_roles SET deleted_at = NOW() WHERE ${scope.col} = $1 AND es_administracion AND deleted_at IS NULL`,
      [scope.id]
    );
    res.json({ ok: true, administracion: await administracionDe(scope) });
  } catch (e) { next(e); }
};

exports.remove = async (req, res, next) => {
  try {
    if (!soloDuenio(req, res)) return;
    const id = Number(req.params.id);
    const scope = scopeDe(req);
    // Si alguien lo tiene, no se borra: quedaría con Administración completa sin querer.
    const { rows: usos } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM user_assignments WHERE custom_role_id = $1 AND revoked_at IS NULL`, [id]
    );
    if (usos[0].n > 0) return res.status(409).json({ ok: false, error: 'rol_en_uso', personas: usos[0].n });
    const { rowCount } = await pool.query(
      `UPDATE app_custom_roles SET deleted_at = NOW() WHERE id = $1 AND ${scope.col} = $2 AND deleted_at IS NULL AND NOT es_administracion AND NOT es_staff_base`,
      [id, scope.id]
    );
    if (!rowCount) return res.status(404).json({ ok: false, error: 'not_found' });
    res.json({ ok: true });
  } catch (e) { next(e); }
};
