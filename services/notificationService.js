// services/notificationService.js
const pool = require('../config/db');

const ALLOWED_TYPES = new Set(['sync_articles', 'sync_sales', 'auto_assign', 'error']);

function safeType(t) {
  const type = String(t || '').trim();
  return ALLOWED_TYPES.has(type) ? type : 'error';
}

/**
 * Crea una notificación de sync
 */
async function createSyncNotification({
  businessId,
  userId,
  type = 'sync_articles',
  title,
  message,
  metadata = {}
}) {
  try {
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
      RETURNING id, created_at
      `,
      [bid, uid, t, ttl, msg, JSON.stringify(meta)]
    );

    return rows[0];
  } catch (error) {
    console.error('[notificationService] Error creando notificación:', error);
    return null;
  }
}

/* ============================================================
   AUTO-ASSIGN (GENÉRICO): soporta artículos y soporta insumos
   - artículos (legacy): details con agrupacion_nombre / articulos_agregados / articulos[]
   - insumos (nuevo):    details con group_nombre / agregados / intentados / rubro / es_elaborador / group_id
   ============================================================ */

/**
 * Normaliza details de distintos "auto-assign" a un formato común:
 * [{ group_id, group_name, added, attempted, rubro, es_elaborador, items }]
 * items opcional: [{id,nombre}] si existe (caso artículos).
 */
function normalizeAutoAssignDetails(details) {
  const arr = Array.isArray(details) ? details : [];

  return arr.map(d => {
    // Caso INSUMOS (autoAssignNewInsumos)
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
      items: Array.isArray(d.articulos) ? d.articulos : null, // puede traer {id,nombre}
    };
  }).filter(x => Number(x.added || 0) > 0);
}

/**
 * Crea notificación específica de auto-asignación (genérica).
 * - Si hay múltiples grupos, arma resumen por grupo.
 * - Si viene `items` con nombres (artículos), muestra hasta 10 por grupo.
 * - Para insumos, muestra rubro + elaborados/no elaborados en el texto si está.
 */
async function notifyAutoAssign({ businessId, userId, result, entity = 'items' }) {
  if (!result) return null;

  // soportar {assigned} (insumos) y {auto_assigned} (algunas respuestas)
  const assigned = Number(result.assigned ?? result.auto_assigned ?? 0);
  if (!Number.isFinite(assigned) || assigned <= 0) return null;

  const normalized = normalizeAutoAssignDetails(result.details);

  // Mensaje de fallback si no hay details “presentables”
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

    // Si trae items con nombres (caso artículos), listamos algunos
    if (Array.isArray(g.items) && g.items.length) {
      const itemsToShow = g.items.slice(0, 10);
      const more = g.items.length > 10 ? `\n  ... y ${g.items.length - 10} más` : '';

      const list = itemsToShow
        .map(a => `  - ${a?.nombre || `#${a?.id ?? '?'}`}`)
        .join('\n');

      return `• "${g.group_name}" (${g.added})${extra}:\n${list}${more}`;
    }

    // Si no hay listado detallado (insumos), solo resumen
    return `• "${g.group_name}" (${g.added})${extra}`;
  }).join('\n\n');

  const title = `Auto-agrupación aplicada`;
  const message = `Se auto-asignaron ${assigned} ${entity}:\n\n${groupsSummary}`;

  // metadata “estable” (sirve para UI futura: click -> ir al grupo)
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

/**
 * Obtiene notificaciones de un usuario
 */
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

/**
 * Marca notificaciones como leídas
 */
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

/**
 * Marca todas las notificaciones como leídas
 */
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

/**
 * Cuenta notificaciones no leídas
 */
async function getUnreadCount(userId, businessId = null) {
  try {
    const uid = Number(userId);
    if (!Number.isFinite(uid) || uid <= 0) return 0;

    let query = 'SELECT COUNT(*)::int AS count FROM sync_notifications WHERE user_id = $1 AND read = false';
    const params = [uid];

    if (businessId) {
      query += ' AND business_id = $2';
      params.push(Number(businessId));
    }

    const { rows } = await pool.query(query, params);
    return Number(rows[0]?.count || 0);
  } catch (error) {
    console.error('[notificationService] Error contando no leídas:', error);
    return 0;
  }
}

module.exports = {
  createSyncNotification,
  notifyAutoAssign,
  getUserNotifications,
  markAsRead,
  markAllAsRead,
  getUnreadCount
};
