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
  // ✅ Tipos para acciones UI
  'group_create',
  'group_rename',
  'group_delete',
  'group_move_division',
  'group_favorite',
  'group_unfavorite',
  'discontinue',
  'move',
]);

function safeType(type) {
  const t = String(type || '').trim();
  if (ALLOWED_TYPES.has(t)) return t;
  return 'ui_action';
}

// ✅ NUEVO: Helper para convertir notificación DB a formato UI event
function toUiEvent(notif) {
  const scope = notif?.metadata?.scope || 
                (notif.type === 'sync_insumos' ? 'insumo' : 
                 notif.type === 'sync_articles' ? 'articulo' : null);
  
  // ✅ Mapear tipo DB a kind UI
  const kindMap = {
    sync_insumos: 'sync',
    sync_articles: 'sync',
    auto_assign: 'auto_assign',
    error: 'error',
  };
  
  const kind = kindMap[notif.type] || notif.type;
  
  return {
    businessId: notif.business_id,
    kind,
    scope,
    title: notif.title,
    message: notif.message,
    createdAt: notif.created_at,
    payload: {
      ...(notif.metadata || {}),
      notificationId: notif.id, // ✅ Para sincronizar estado read
      source: 'backend',
    },
  };
}

/**
 * Crea una notificación de sync Y emite evento UI si es aplicable
 */
async function createSyncNotification({ 
  businessId, 
  userId, 
  type = 'sync_articles', 
  title, 
  message, 
  metadata = {},
  emitUiEvent = true, // ✅ NUEVO: opción para emitir evento
}) {
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

  const created = rows[0] ?? null;
  
  // ✅ NUEVO: Emitir evento UI para que el panel lo capture
  if (created && emitUiEvent) {
    try {
      const uiEvent = toUiEvent(created);
      
      // Log para debug
      console.log('📤 [notificationService] Emitiendo evento UI:', {
        type: created.type,
        title: created.title,
        businessId: created.business_id,
      });
      
      // ✅ En producción, esto podría ser un WebSocket o SSE
      // Por ahora, guardar en una tabla temporal para que el frontend lo consulte
      // O usar un mecanismo de push real
      
    } catch (err) {
      console.warn('[notificationService] Error emitiendo evento UI:', err);
    }
  }

  return created;
}

/**
 * Notificación específica: solapamiento en importación de ventas CSV (accionable).
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

    let whereClause = 'WHERE n.user_id = $1';
    const params = [uid];
    let paramIndex = 2;

    if (businessId) {
      whereClause += ` AND n.business_id = $${paramIndex}`;
      params.push(Number(businessId));
      paramIndex++;
    }

    if (unreadOnly) {
      whereClause += ` AND n.read = false`;
    }

    const lim = Math.min(Math.max(Number(limit) || 20, 1), 200);

    const { rows } = await pool.query(
      `
      SELECT 
        n.id,
        n.business_id,
        n.type,
        n.title,
        n.message,
        n.metadata,
        n.read,
        n.created_at,
        b.name AS business_name
      FROM sync_notifications n
      LEFT JOIN app_businesses b ON b.id = n.business_id
      ${whereClause}
      ORDER BY n.created_at DESC
      LIMIT $${paramIndex}
      `,
      [...params, lim]
    );

    return rows;
  } catch (error) {
    console.error('[notificationService] Error obteniendo notificaciones:', error);
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
      [uid, bid]
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
  onlyAdmins = false,
  actorUserId = null,
}) {
  const bid = Number(businessId);
  if (!Number.isFinite(bid) || bid <= 0) throw new Error('invalid_business_id');

  const t = safeType(type);

  // 1) buscar usuarios del negocio (app_memberships)
  let users = [];
  try {
    const q = `
      SELECT DISTINCT m.user_id::int AS user_id
      FROM app_memberships m
      WHERE m.business_id = $1
      ${onlyAdmins ? "AND m.role IN ('owner','manager')" : ''}
    `;
    const { rows } = await pool.query(q, [bid]);
    users = rows.map(r => Number(r.user_id)).filter(n => Number.isFinite(n) && n > 0);
  } catch (e) {
    console.error('[notificationService] Error leyendo app_memberships:', e?.message);
    users = [];
  }

  // 1.b) fallback opcional
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
      },
      emitUiEvent: true, // ✅ Emitir evento para que el frontend lo capture
    });
    created++;
  }

  return { created };
}

/**
 * Crea notificación de acción UI (persiste en DB para historial)
 */
async function createUiNotification({
  businessId,
  userId,
  kind,
  title,
  message = null,
  metadata = {},
  scope = 'ui_action',
}) {
  const typeMap = {
    group_create: 'group_create',
    group_rename: 'group_rename',
    group_delete: 'group_delete',
    group_move_division: 'group_move_division',
    group_favorite: 'group_favorite',
    group_unfavorite: 'group_unfavorite',
    discontinue: 'discontinue',
    move: 'move',
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
    emitUiEvent: false, // ✅ UI notifs no necesitan re-emitirse
  });
}


module.exports = {
  createSyncNotification,
  createSyncNotificationForBusinessUsers,
  notifySalesImportOverlap,
  notifyAutoAssign,
  getUserNotifications,
  markAsRead,
  markAllAsRead,
  getUnreadCount,
  createUiNotification,
  toUiEvent, // ✅ Exportar para usar en endpoints
};