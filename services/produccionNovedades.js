// services/produccionNovedades.js — Producción › Novedades de cocina (etapa 1, 24/11/2026).
// Avisos entre el equipo de cocina con foto opcional:
//   · Crean y ven: cocineros (staff), jefes de cocina, dueño y admin.
//   · Marcar «Vista» o eliminar (borrado lógico): SOLO dueño y admin (c.gestor → 403 para staff/jefe).
//   · Todo filtrado por business_id y sucursal (branch_id).
'use strict';

const pool = require('../config/db');
const { _ctx } = require('./produccion');
const { sqlEsCocina } = require('./auth/permisos');
const { createSyncNotification, avisarAbm } = require('./notificationService');

const { contextoDe, fallar, exigir } = _ctx;

const TIPOS_NOVEDAD = [
  { key: 'danado', label: 'Algo dañado' },
  { key: 'sucio', label: 'Algo sucio' },
  { key: 'limpieza', label: 'Se hizo limpieza' },
  { key: 'estado', label: 'Cómo quedó algo' },
  { key: 'otro', label: 'Otro' },
];
const MAPA_TIPOS = new Map(TIPOS_NOVEDAD.map((t) => [t.key, t.label]));

const nombreUsuario = (alias) => `COALESCE(NULLIF(${alias}.display_name, ''), NULLIF(${alias}.name, ''), split_part(${alias}.email, '@', 1))`;

/** Normaliza y valida el tipo de novedad (acepta la clave o la etiqueta). */
function normalizarTipo(raw) {
  const s = String(raw ?? '').trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (!s) return null;
  if (MAPA_TIPOS.has(s)) return s;
  if (s.includes('danad')) return 'danado';
  if (s.includes('suci')) return 'sucio';
  if (s.includes('limpieza')) return 'limpieza';
  if (s.includes('quedo') || s === 'estado') return 'estado';
  if (s === 'otro') return 'otro';
  return null;
}

/** Valida que solo dueño/admin puedan marcar vista o eliminar una novedad (403 si es cocinero o jefe). */
function exigirDuenoOAdmin(c) {
  exigir(!!(c && c.gestor), 'forbidden');
}

function formatoNovedad(r) {
  const tipo = MAPA_TIPOS.has(r.tipo) ? r.tipo : 'otro';
  return {
    id: Number(r.id),
    tipo,
    tipo_label: MAPA_TIPOS.get(tipo) || 'Otro',
    texto: r.texto,
    foto_url: r.foto_url || null,
    foto_public_id: r.foto_public_id || null,
    user_id: r.user_id ? Number(r.user_id) : null,
    usuario: r.usuario || 'Equipo',
    vista: !!r.vista_at,
    vista_at: r.vista_at || null,
    vista_por_id: r.vista_por ? Number(r.vista_por) : null,
    vista_por: r.vista_por_nombre || null,
    created_at: r.created_at,
  };
}

/** Destinatarios de un aviso de novedad: todo el equipo de cocina del negocio (subroles con es_cocina y jefes) + dueño/admin. */
async function destinatariosCocinaYDueno(bizId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT uid FROM (
       SELECT owner_id AS uid FROM app_businesses WHERE id = $1
       UNION SELECT m.user_id FROM app_memberships m WHERE m.business_id = $1 AND m.role IN ('owner','manager')
       UNION SELECT ua.user_id FROM user_assignments ua
              WHERE ua.revoked_at IS NULL
                AND (ua.role IN ('admin','owner') OR ${sqlEsCocina('ua')})
                AND ((ua.scope_type = 'business' AND ua.scope_id = $1)
                  OR (ua.scope_type = 'organization' AND ua.scope_id = (SELECT organization_id FROM app_businesses WHERE id = $1)))
     ) x WHERE uid IS NOT NULL`,
    [bizId]
  );
  return rows.map((r) => Number(r.uid)).filter((n) => Number.isFinite(n) && n > 0);
}

async function avisarNuevaNovedad(c, novedad) {
  const { rows: yo } = await pool.query(
    `SELECT COALESCE(NULLIF(display_name, ''), NULLIF(name, ''), split_part(email, '@', 1)) AS n FROM app_users WHERE id = $1`,
    [c.uid]
  );
  const actorNombre = yo[0]?.n || null;
  const meta = {
    kind: 'produccion_novedad',
    novedad_id: Number(novedad.id),
    tipo: novedad.tipo,
    actor_user_id: c.uid,
    actor_nombre: actorNombre,
    actor_rol: c.gestor ? 'gestor' : c.jefe ? 'jefe' : 'cocina',
  };
  const title = `Novedad de cocina · ${novedad.tipo_label}`;
  const message = String(novedad.texto || '').slice(0, 180);
  const uids = new Set(await destinatariosCocinaYDueno(c.bizId));
  uids.add(Number(c.uid));

  for (const uid of uids) {
    if (!uid) continue;
    // Quien la creó no recibe ventanita sin leer: le queda ya leída en «Mías».
    const esActor = Number(uid) === Number(c.uid);
    await pool.query(
      `INSERT INTO sync_notifications (business_id, user_id, type, title, message, metadata, created_at, read)
       VALUES ($1, $2, 'produccion_novedad', $3, $4, $5::jsonb, NOW(), $6)`,
      [c.bizId, uid, title, message, JSON.stringify(meta), esActor]
    ).catch(() => {});
  }
}

async function listarNovedades(req) {
  const c = await contextoDe(req);
  const tipoFiltro = req.query?.tipo ? normalizarTipo(req.query.tipo) : null;
  const userFiltro = Number(req.query?.userId) || null;
  const { rows } = await pool.query(
    `SELECT n.*, ${nombreUsuario('u')} AS usuario, ${nombreUsuario('uv')} AS vista_por_nombre
       FROM produccion_novedades n
       LEFT JOIN app_users u ON u.id = n.user_id
       LEFT JOIN app_users uv ON uv.id = n.vista_por
      WHERE n.business_id = $1
        AND n.branch_id IS NOT DISTINCT FROM $2::bigint
        AND n.deleted_at IS NULL
        AND ($3::text IS NULL OR n.tipo = $3)
        AND ($4::bigint IS NULL OR n.user_id = $4)
      ORDER BY n.created_at DESC, n.id DESC
      LIMIT 200`,
    [c.bizId, c.suc, tipoFiltro, userFiltro]
  );
  return {
    tipos: TIPOS_NOVEDAD,
    puede_gestionar: !!c.gestor,
    items: rows.map(formatoNovedad),
  };
}

async function crearNovedad(req) {
  const c = await contextoDe(req);
  const b = req.body || {};
  const tipo = normalizarTipo(b.tipo);
  if (!tipo) fallar(400, 'tipo_invalido', 'Elegí el tipo de novedad');
  const texto = String(b.texto || '').trim().slice(0, 1500);
  if (!texto) fallar(400, 'texto_requerido', 'Escribí el detalle de la novedad');
  const fotoUrl = b.foto_url ? String(b.foto_url).trim().slice(0, 600) : null;
  const fotoPublicId = b.foto_public_id ? String(b.foto_public_id).trim().slice(0, 240) : null;
  if (fotoUrl && !/^https:\/\/res\.cloudinary\.com\//i.test(fotoUrl)) {
    fallar(400, 'foto_invalida', 'La foto debe subirse primero');
  }
  const { rows } = await pool.query(
    `INSERT INTO produccion_novedades (business_id, branch_id, tipo, texto, foto_url, foto_public_id, user_id)
     VALUES ($1, $2::bigint, $3, $4, $5, $6, $7)
     RETURNING id`,
    [c.bizId, c.suc, tipo, texto, fotoUrl, fotoPublicId, c.uid]
  );
  const id = Number(rows[0].id);
  const nov = { id, tipo, tipo_label: MAPA_TIPOS.get(tipo) || 'Otro', texto };
  avisarNuevaNovedad(c, nov).catch((e) => console.error('[novedades aviso]', e?.message));
  return listarNovedades({ ...req, query: {} });
}

async function marcarVista(req) {
  const c = await contextoDe(req);
  exigirDuenoOAdmin(c);
  const id = Number(req.params.id);
  if (!id) fallar(400, 'id_invalido');
  const { rows } = await pool.query(
    `UPDATE produccion_novedades
        SET vista_at = COALESCE(vista_at, NOW()),
            vista_por = COALESCE(vista_por, $3)
      WHERE id = $1 AND business_id = $2 AND deleted_at IS NULL
      RETURNING id, tipo, texto, user_id`,
    [id, c.bizId, c.uid]
  );
  if (!rows.length) fallar(404, 'novedad_no_encontrada');
  const r = rows[0];
  const tipoLabel = MAPA_TIPOS.get(r.tipo) || 'Otro';
  const msg = String(r.texto || '').slice(0, 140);
  avisarAbm(req, {
    businessId: c.bizId,
    type: 'produccion_novedad',
    title: `Novedad marcada como vista · ${tipoLabel}`,
    message: msg,
    metadata: { kind: 'produccion_novedad', novedad_id: id, accion: 'vista' },
  });
  if (r.user_id && Number(r.user_id) !== Number(c.uid)) {
    createSyncNotification({
      businessId: c.bizId,
      userId: Number(r.user_id),
      type: 'produccion_novedad',
      title: `Vieron tu novedad · ${tipoLabel}`,
      message: msg,
      metadata: { kind: 'produccion_novedad', novedad_id: id, accion: 'vista', actor_user_id: c.uid },
    }).catch(() => {});
  }
  return listarNovedades({ ...req, query: {} });
}

async function borrarNovedad(req) {
  const c = await contextoDe(req);
  exigirDuenoOAdmin(c);
  const id = Number(req.params.id);
  if (!id) fallar(400, 'id_invalido');
  const { rows } = await pool.query(
    `UPDATE produccion_novedades
        SET deleted_at = NOW(), deleted_by = $3
      WHERE id = $1 AND business_id = $2 AND deleted_at IS NULL
      RETURNING id, tipo, texto`,
    [id, c.bizId, c.uid]
  );
  if (!rows.length) fallar(404, 'novedad_no_encontrada');
  const r = rows[0];
  const tipoLabel = MAPA_TIPOS.get(r.tipo) || 'Otro';
  avisarAbm(req, {
    businessId: c.bizId,
    type: 'produccion_novedad',
    title: `Novedad eliminada · ${tipoLabel}`,
    message: String(r.texto || '').slice(0, 140),
    metadata: { kind: 'produccion_novedad', novedad_id: id, accion: 'eliminada' },
  });
  return listarNovedades({ ...req, query: {} });
}

module.exports = {
  TIPOS_NOVEDAD,
  listarNovedades,
  crearNovedad,
  marcarVista,
  borrarNovedad,
  _puros: { normalizarTipo, exigirDuenoOAdmin, formatoNovedad, TIPOS_NOVEDAD },
};
