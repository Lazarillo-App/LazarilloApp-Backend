// services/notificationService.js
const pool = require('../config/db');

const ALLOWED_TYPES = new Set([
  'sync_insumos',
  'sync_articles',
  'sync_sales',
  'auto_assign',
  'sales_import_overlap',
  'ui_action',
  'error',
  // ✅ NUEVOS tipos para acciones UI
  'group_create',
  'group_rename',
  'group_delete',
  'group_move_division',
  'group_favorite',
  'group_unfavorite',
  'discontinue',
  'move',
  'receta_observacion',
  'access_request',
  // Alta/baja/mover de artículos e insumos — permitidos en notificationsRoutes.js
  // (allowedKinds) desde antes, pero faltaban acá: sin esto, createUiNotification
  // los degradaba a 'ui_action' vía safeType() y el frontend perdía el kind real
  // al releer la notificación guardada (backendNotifs mapea kind desde n.type).
  'articulo_create', 'articulo_delete', 'articulo_move',
  'insumo_create', 'insumo_delete', 'insumo_move',
  // RRHH (Diego 12/11/2026: todo ABM queda en Notificaciones)
  'rrhh_empleado_alta', 'rrhh_empleado_baja', 'rrhh_empleado_reactivar', 'rrhh_empleado_edit',
  'rrhh_empleado_no_aplica', 'rrhh_nomina', 'rrhh_config', 'rrhh_cronograma',
  // Recetas (misma regla)
  'receta_save', 'receta_delete', 'receta_bulk', 'receta_import', 'insumo_elaborado',
  // Insumos (misma regla)
  'insumo_edit', 'insumo_group', 'insumo_rubro', 'insumo_merma', 'insumo_equivalencia',
  'insumo_bonificacion', 'insumo_uso', 'insumo_import', 'insumo_reemplazo',
  // Usuarios (Diego 12/11/2026)
  'usuario_email',
]);

function safeType(type) {
  const t = String(type || '').trim();
  if (ALLOWED_TYPES.has(t)) return t;
  return 'ui_action';
}

/**
 * Crea una notificación de sync
 */
async function createSyncNotification({ businessId, userId, type = 'sync_articles', title, message, metadata = {} }) {
  const bid = Number(businessId);
  const uid = Number(userId);

  if (!Number.isFinite(bid) || bid <= 0) throw new Error('invalid_business_id');
  if (!Number.isFinite(uid) || uid <= 0) throw new Error('invalid_user_id');

  const t = safeType(type);
  const ttl = String(title || '').trim();
  if (!ttl) throw new Error('title_required');

  const msg = message == null ? null : String(message);
  const meta = (metadata && typeof metadata === 'object') ? metadata : {};

  const { rows } = await pool.query(
    `
    INSERT INTO sync_notifications
      (business_id, user_id, type, title, message, metadata, created_at, read)
    VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW(), false)
    RETURNING *
    `,
    [bid, uid, t, ttl, msg, JSON.stringify(meta)]
  );

  return rows[0] ?? null;
}

/**
 * Notificación específica: solapamiento en importación de ventas CSV (accionable).
 * metadata recomendado:
 * { scope:'sales_import', change_set_id, import_id, range:{from,to}, stats:{...}, suggested_action:'replace_range' }
 */
async function notifySalesImportOverlap({
  businessId,
  userId,
  changeSetId,
  importId,
  range,
  stats
}) {
  const from = range?.from;
  const to = range?.to;

  const title = 'Ventas CSV: solapamiento detectado';

  const deltaAmt = Number(stats?.delta_amount ?? 0);
  const deltaQty = Number(stats?.delta_qty ?? 0);
  const rowsChanged = Number(stats?.rows_changed ?? 0);
  const rowsNew = Number(stats?.rows_new ?? 0);

  // Mensaje corto, tipo “toast”, pero con data útil.
  const message =
    `Rango ${from} → ${to}. ` +
    `Cambios: ${rowsChanged}, Nuevos: ${rowsNew}. ` +
    `Δ$ ${deltaAmt}${Number.isFinite(deltaQty) ? `, Δqty ${deltaQty}` : ''}.`;

  return createSyncNotification({
    businessId,
    userId,
    type: 'sales_import_overlap',
    title,
    message,
    metadata: {
      scope: 'sales_import',
      change_set_id: changeSetId,
      import_id: importId,
      range: { from, to },
      stats: stats || {},
      suggested_action: 'replace_range',
    }
  });
}

/* ============================================================
   AUTO-ASSIGN (GENÉRICO): soporta artículos y soporta insumos
   ============================================================ */

function normalizeAutoAssignDetails(details) {
  const arr = Array.isArray(details) ? details : [];

  return arr.map(d => {
    // Caso INSUMOS
    if (d && (d.group_id != null || d.group_nombre != null)) {
      return {
        group_id: d.group_id ?? null,
        group_name: d.group_nombre ?? 'Sin nombre',
        added: Number(d.agregados ?? 0),
        attempted: Number(d.intentados ?? 0),
        rubro: d.rubro ?? null,
        es_elaborador: d.es_elaborador ?? null,
        items: null,
      };
    }

    // Caso ARTÍCULOS (legacy)
    return {
      group_id: d.agrupacion_id ?? null,
      group_name: d.agrupacion_nombre ?? 'Sin nombre',
      added: Number(d.articulos_agregados ?? 0),
      attempted: Number(d.articulos_intentados ?? d.articulos_agregados ?? 0),
      rubro: null,
      es_elaborador: null,
      items: Array.isArray(d.articulos) ? d.articulos : null,
    };
  }).filter(x => Number(x.added || 0) > 0);
}

async function notifyAutoAssign({ businessId, userId, result, entity = 'items' }) {
  if (!result) return null;

  const assigned = Number(result.assigned ?? result.auto_assigned ?? 0);
  if (!Number.isFinite(assigned) || assigned <= 0) return null;

  const normalized = normalizeAutoAssignDetails(result.details);

  if (!normalized.length) {
    const title = `Auto-agrupación aplicada`;
    const message = `Se auto-asignaron ${assigned} ${entity}.`;

    return createSyncNotification({
      businessId,
      userId,
      type: 'auto_assign',
      title,
      message,
      metadata: { entity, assigned }
    });
  }

  const groupsSummary = normalized.map(g => {
    const extra =
      g.rubro
        ? ` (Rubro ${g.rubro}${g.es_elaborador ? ', elaborados' : ', no elaborados'})`
        : '';

    if (Array.isArray(g.items) && g.items.length) {
      const itemsToShow = g.items.slice(0, 10);
      const more = g.items.length > 10 ? `\n  ... y ${g.items.length - 10} más` : '';

      const list = itemsToShow
        .map(a => `  - ${a?.nombre || `#${a?.id ?? '?'}`}`)
        .join('\n');

      return `• "${g.group_name}" (${g.added})${extra}:\n${list}${more}`;
    }

    return `• "${g.group_name}" (${g.added})${extra}`;
  }).join('\n\n');

  const title = `Auto-agrupación aplicada`;
  const message = `Se auto-asignaron ${assigned} ${entity}:\n\n${groupsSummary}`;

  const metaGroups = normalized.map(g => ({
    group_id: g.group_id,
    group_name: g.group_name,
    added: g.added,
    attempted: g.attempted,
    rubro: g.rubro,
    es_elaborador: g.es_elaborador,
  }));

  return createSyncNotification({
    businessId,
    userId,
    type: 'auto_assign',
    title,
    message,
    metadata: {
      entity,
      assigned,
      groups: metaGroups,
    }
  });
}

async function getUserNotifications(userId, { businessId, limit = 20, unreadOnly = false } = {}) {
  try {
    const uid = Number(userId);
    if (!Number.isFinite(uid) || uid <= 0) return [];

    const params = [uid];
    let base = "WHERE n.user_id = $1";
    if (businessId) {
      params.push(Number(businessId));
      base += ` AND n.business_id = $${params.length}`;
    }

    const lim = Math.min(Math.max(Number(limit) || 20, 1), 200);
    const cols = `
      SELECT
        n.id, n.business_id, n.type, n.title, n.message, n.metadata,
        n.read, n.created_at, b.name AS business_name
      FROM sync_notifications n
      LEFT JOIN app_businesses b ON b.id = n.business_id`;

    // Las NO leídas se devuelven todas (no se cortan por el límite): quedan hasta
    // que alguien las marque como leídas. Las leídas, solo las más recientes.
    const { rows: noLeidas } = await pool.query(
      `${cols} ${base} AND n.read = false ORDER BY n.created_at DESC LIMIT 500`,
      params
    );
    if (unreadOnly) return noLeidas;

    params.push(lim);
    const { rows: leidas } = await pool.query(
      `${cols} ${base} AND n.read = true ORDER BY n.created_at DESC LIMIT $${params.length}`,
      params
    );
    return [...noLeidas, ...leidas];
  } catch (error) {
    console.error("[notificationService] Error obteniendo notificaciones:", error);
    return [];
  }
}

async function markAsRead(userId, notificationIds) {
  if (!Array.isArray(notificationIds) || notificationIds.length === 0) {
    return { updated: 0 };
  }

  try {
    const uid = Number(userId);
    const ids = notificationIds.map(Number).filter(n => Number.isFinite(n) && n > 0);
    if (!Number.isFinite(uid) || uid <= 0) return { updated: 0 };
    if (!ids.length) return { updated: 0 };

    const { rowCount } = await pool.query(
      `
      UPDATE sync_notifications
      SET read = true
      WHERE user_id = $1
        AND id = ANY($2::bigint[])
        AND read = false
      `,
      [uid, ids]
    );

    return { updated: rowCount || 0 };
  } catch (error) {
    console.error('[notificationService] Error marcando como leídas:', error);
    return { updated: 0 };
  }
}

async function markAllAsRead(userId, businessId = null) {
  try {
    const uid = Number(userId);
    if (!Number.isFinite(uid) || uid <= 0) return { updated: 0 };

    let query = 'UPDATE sync_notifications SET read = true WHERE user_id = $1 AND read = false';
    const params = [uid];

    if (businessId) {
      query += ' AND business_id = $2';
      params.push(Number(businessId));
    }

    const { rowCount } = await pool.query(query, params);
    return { updated: rowCount || 0 };
  } catch (error) {
    console.error('[notificationService] Error marcando todas como leídas:', error);
    return { updated: 0 };
  }
}

async function getUnreadCount(userId, businessId = null) {
  try {
    const uid = Number(userId);
    if (!Number.isFinite(uid) || uid <= 0) return 0;

    const bid = businessId == null ? null : Number(businessId);
    if (bid !== null && (!Number.isFinite(bid) || bid <= 0)) return 0;

    const { rows } = await pool.query(
      `
      SELECT COUNT(*)::int AS count
      FROM sync_notifications
      WHERE user_id = $1
        AND ($2::int IS NULL OR business_id = $2)
        AND read = false
      `,
      [uid, bid] // ✅ siempre 2 params
    );

    return Number(rows[0]?.count || 0);
  } catch (error) {
    console.error('[notificationService] Error contando no leídas:', error);
    return 0;
  }
}

/**
 * Crea la misma notificación para todos los usuarios vinculados a un negocio.
 * Ideal para CRON (no hay req.user).
 */
async function createSyncNotificationForBusinessUsers({
  businessId,
  type = 'sync_insumos',
  title,
  message,
  metadata = {},
  onlyAdmins = false,   // por ahora false
  actorUserId = null,
}) {
  const bid = Number(businessId);
  if (!Number.isFinite(bid) || bid <= 0) throw new Error('invalid_business_id');

  const t = safeType(type);

  // 1) buscar usuarios del negocio (app_memberships)
  let users = [];
  try {
    // onlyAdmins: dueño + admins asignados al negocio o a su organización (user_assignments)
    const q = onlyAdmins
      ? `
        SELECT DISTINCT uid::int AS user_id FROM (
          SELECT owner_id AS uid FROM app_businesses WHERE id = $1
          UNION
          SELECT m.user_id AS uid FROM app_memberships m
           WHERE m.business_id = $1 AND m.role IN ('owner','manager')
          UNION
          SELECT ua.user_id AS uid FROM user_assignments ua
           WHERE ua.revoked_at IS NULL AND ua.role IN ('admin','owner')
             AND ((ua.scope_type = 'business' AND ua.scope_id = $1)
               OR (ua.scope_type = 'organization' AND ua.scope_id = (SELECT organization_id FROM app_businesses WHERE id = $1)))
        ) x WHERE uid IS NOT NULL
      `
      : `
      SELECT DISTINCT m.user_id::int AS user_id
      FROM app_memberships m
      WHERE m.business_id = $1
    `;
    const { rows } = await pool.query(q, [bid]);
    users = rows.map(r => Number(r.user_id)).filter(n => Number.isFinite(n) && n > 0);
  } catch (e) {
    console.error('[notificationService] Error leyendo app_memberships:', e?.message);
    users = [];
  }

  // 1.b) fallback opcional (si por algún motivo hay users en user_businesses y no en memberships)
  if (!users.length) {
    try {
      const q2 = `
        SELECT DISTINCT ub.user_id::int AS user_id
        FROM user_businesses ub
        WHERE ub.business_id = $1
        ${onlyAdmins ? "AND ub.role IN ('owner','manager')" : ''}
      `;
      const { rows } = await pool.query(q2, [bid]);
      users = rows.map(r => Number(r.user_id)).filter(n => Number.isFinite(n) && n > 0);
    } catch (e2) {
      console.error('[notificationService] Error leyendo user_businesses:', e2?.message);
      users = [];
    }
  }

  if (!users.length) return { created: 0 };

  // 2) crear notificación por usuario
  let created = 0;
  for (const uid of users) {
    await createSyncNotification({
      businessId: bid,
      userId: uid,
      type: t,
      title,
      message,
      metadata: {
        ...metadata,
        actor_user_id: actorUserId,
      }
    });
    created++;
  }

  return { created };
}

/**
 * Crea notificación de acción UI (persiste en DB para historial)
 * Usado cuando el usuario hace algo en la UI que queremos trackear
 */
async function createUiNotification({
  businessId,
  userId,
  kind,           // ✅ 'group_create', 'discontinue', etc.
  title,
  message = null,
  metadata = {},
  scope = 'ui_action', // ✅ 'articulo' o 'insumo'
}) {
  // ✅ Mapear kind a type permitido
  const typeMap = {
    group_create: 'group_create',
    group_rename: 'group_rename',
    group_delete: 'group_delete',
    group_move_division: 'group_move_division',
    group_favorite: 'group_favorite',
    group_unfavorite: 'group_unfavorite',
    discontinue: 'discontinue',
    move: 'move',
    articulo_create: 'articulo_create',
    articulo_delete: 'articulo_delete',
    articulo_move: 'articulo_move',
    insumo_create: 'insumo_create',
    insumo_delete: 'insumo_delete',
    insumo_move: 'insumo_move',
  };

  const type = typeMap[kind] || 'ui_action';

  return createSyncNotification({
    businessId,
    userId,
    type,
    title,
    message,
    metadata: {
      kind,
      scope,
      ...metadata,
    },
  });
};


/**
 * Aviso al equipo de gestión de un negocio cuando alguien crea, borra o discontinúa un
 * artículo o insumo (Diego 12/11/2026: «un usuario creó el artículo y no aparece en
 * notificaciones»). Antes estas acciones solo se avisaban en la sesión de quien las hacía.
 *
 * Destinatarios: dueño del negocio + owner/admin asignados al negocio o a su organización
 * (user_assignments) + owner/manager de app_memberships. No le llega a quien hizo la acción
 * (ya la ve en su pantalla). Un solo INSERT … SELECT, sin un pedido por persona.
 * metadata.actor_user_id / actor_nombre → el panel separa «Mías» de «Del equipo».
 */
/*
 * Opciones (regla «todo ABM queda en Notificaciones», Diego 12/11/2026):
 *  · incluirActor: quien hizo el cambio también lo recibe, ya LEÍDO (queda en «Mías» sin sumar
 *    al número de la campana). Por defecto false para no duplicar lo que algunas pantallas
 *    viejas todavía persisten desde el front (usePersistUiActions).
 *  · clave + agruparMin: si ya hay un aviso con esa clave en los últimos N minutos, se actualiza
 *    en vez de crear otro (ej. el autoguardado de un cronograma no llena la campana).
 */
async function avisarAlEquipo({ businessId, actorUserId = null, type, title, message = null, metadata = {}, incluirActor = false, clave = null, agruparMin = 30 }) {
  const bid = Number(businessId);
  if (!Number.isFinite(bid) || bid <= 0) return { created: 0 };
  const ttl = String(title || '').trim();
  if (!ttl) return { created: 0 };
  const actor = Number(actorUserId) || null;
  let actorNombre = null;
  if (actor) {
    const { rows } = await pool.query(
      `SELECT COALESCE(NULLIF(display_name, ''), NULLIF(name, ''), split_part(email, '@', 1)) AS n FROM app_users WHERE id = $1`,
      [actor]
    );
    actorNombre = rows[0]?.n || null;
  }
  const meta = { ...(metadata || {}), actor_user_id: actor, actor_nombre: actorNombre, ...(clave ? { clave: String(clave) } : {}) };
  if (clave) {
    // mismo aviso reciente → se renueva (vuelve a no leído para el resto del equipo)
    const up = await pool.query(
      `UPDATE sync_notifications
          SET title = $3, message = $4, metadata = $5::jsonb, created_at = NOW(),
              read = CASE WHEN user_id = COALESCE($6::int, -1) THEN TRUE ELSE FALSE END
        WHERE business_id = $1 AND metadata->>'clave' = $2
          AND created_at > NOW() - ($7::int * INTERVAL '1 minute')`,
      [bid, String(clave), ttl, message == null ? null : String(message), JSON.stringify(meta), actor, Number(agruparMin) || 30]
    );
    if (up.rowCount) return { created: 0, updated: up.rowCount };
  }
  const { rowCount } = await pool.query(
    `INSERT INTO sync_notifications (business_id, user_id, type, title, message, metadata, created_at, read)
     SELECT $1, uid, $2, $3, $4, $5::jsonb, NOW(), (uid = COALESCE($6::int, -1))
       FROM (
         SELECT owner_id AS uid FROM app_businesses WHERE id = $1
         UNION
         SELECT m.user_id FROM app_memberships m WHERE m.business_id = $1 AND m.role IN ('owner','manager')
         UNION
         SELECT ua.user_id FROM user_assignments ua
          WHERE ua.revoked_at IS NULL AND ua.role IN ('admin','owner')
            AND ((ua.scope_type = 'business' AND ua.scope_id = $1)
              OR (ua.scope_type = 'organization' AND ua.scope_id = (SELECT organization_id FROM app_businesses WHERE id = $1)))
         UNION
         SELECT $6::int WHERE $7::boolean AND $6::int IS NOT NULL
       ) x
      WHERE uid IS NOT NULL AND ($7::boolean OR uid <> COALESCE($6::int, -1))`,
    [bid, safeType(type), ttl, message == null ? null : String(message), JSON.stringify(meta), actor, !!incluirActor]
  );
  return { created: rowCount };
}

/**
 * Atajo para los endpoints de ABM (regla «todo ABM queda en Notificaciones», 12/11/2026):
 * toma negocio y autor del request; el autor lo recibe ya leído («Mías»).
 */
function avisarAbm(req, { businessId, type, title, message = null, metadata = {}, clave = null, agruparMin = 30 }) {
  const bid = Number(businessId ?? req?.businessId ?? req?.params?.businessId);
  const actor = Number(req?.user?.id) || null;
  avisarAlEquipoSinEsperar({
    businessId: bid, actorUserId: actor, type, title, message,
    metadata: { kind: type, ...metadata }, incluirActor: !!actor, clave, agruparMin,
  });
}

/** Igual que avisarAlEquipo pero sin bloquear la respuesta ni romperla si falla. */
function avisarAlEquipoSinEsperar(args) {
  avisarAlEquipo(args).catch((e) => console.error('[avisarAlEquipo]', args?.type, e?.message));
}

module.exports = {
  avisarAlEquipo,
  avisarAlEquipoSinEsperar,
  avisarAbm,
  createSyncNotification,
  createSyncNotificationForBusinessUsers,
  notifySalesImportOverlap,
  notifyAutoAssign,
  getUserNotifications,
  markAsRead,
  markAllAsRead,
  getUnreadCount,
  createUiNotification
};