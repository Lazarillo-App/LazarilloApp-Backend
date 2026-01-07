// services/notificationService.js
const pool = require('../config/db');

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
    const { rows } = await pool.query(`
      INSERT INTO sync_notifications 
        (business_id, user_id, type, title, message, metadata, created_at)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW())
      RETURNING id, created_at
    `, [businessId, userId, type, title, message, JSON.stringify(metadata)]);

    return rows[0];
  } catch (error) {
    console.error('[notificationService] Error creando notificación:', error);
    return null;
  }
}

/**
 * Crea notificación específica de auto-asignación
 */
async function notifyAutoAssign({ businessId, userId, result }) {
  if (!result || !result.assigned || result.assigned === 0) {
    return null;
  }

  const { assigned, details = [] } = result;

  const groupsSummary = details
    .map(d => `• ${d.articulos_agregados} → "${d.agrupacion_nombre}"`)
    .join('\n');

  const title = `${assigned} artículo${assigned > 1 ? 's' : ''} asignado${assigned > 1 ? 's' : ''} automáticamente`;
  const message = `Los siguientes artículos fueron asignados:\n\n${groupsSummary}`;

  return createSyncNotification({
    businessId,
    userId,
    type: 'auto_assign',
    title,
    message,
    metadata: {
      total_assigned: assigned,
      groups: details.map(d => ({
        group_id: d.agrupacion_id,
        group_name: d.agrupacion_nombre,
        article_count: d.articulos_agregados,
        article_ids: d.articulos
      }))
    }
  });
}

/**
 * Obtiene notificaciones de un usuario
 */
async function getUserNotifications(userId, { businessId, limit = 20, unreadOnly = false } = {}) {
  try {
    let whereClause = 'WHERE user_id = $1';
    const params = [userId];
    let paramIndex = 2;

    if (businessId) {
      whereClause += ` AND business_id = $${paramIndex}`;
      params.push(businessId);
      paramIndex++;
    }

    if (unreadOnly) {
      whereClause += ` AND read = false`;
    }

    const { rows } = await pool.query(`
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
    `, [...params, limit]);

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
    const { rowCount } = await pool.query(`
      UPDATE sync_notifications
      SET read = true
      WHERE user_id = $1
        AND id = ANY($2::bigint[])
        AND read = false
    `, [userId, notificationIds]);

    return { updated: rowCount };
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
    let query = 'UPDATE sync_notifications SET read = true WHERE user_id = $1 AND read = false';
    const params = [userId];

    if (businessId) {
      query += ' AND business_id = $2';
      params.push(businessId);
    }

    const { rowCount } = await pool.query(query, params);
    return { updated: rowCount };
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
    let query = 'SELECT COUNT(*) AS count FROM sync_notifications WHERE user_id = $1 AND read = false';
    const params = [userId];

    if (businessId) {
      query += ' AND business_id = $2';
      params.push(businessId);
    }

    const { rows } = await pool.query(query, params);
    return parseInt(rows[0]?.count || 0, 10);
  } catch (error) {
    console.error('[notificationService] Error contando no leídas:', error);
    return 0;
  }
};

async function notifyAutoAssign({ businessId, userId, result }) {
  if (!result || !result.assigned || result.assigned === 0) {
    return null;
  }

  const { assigned, details = [] } = result;

  // 🆕 Formatear con nombres de artículos
  const groupsSummary = details.map(d => {
    const articulos = d.articulos || [];
    
    // Limitar a 10 artículos por grupo para no saturar
    const articulosAMostrar = articulos.slice(0, 10);
    const hayMas = articulos.length > 10;
    
    const articulosList = articulosAMostrar
      .map(a => `  - ${a.nombre || `#${a.id}`}`)
      .join('\n');
    
    const masTexto = hayMas ? `  ... y ${articulos.length - 10} más` : '';
    
    return `• Grupo "${d.agrupacion_nombre}" (${d.articulos_agregados}):\n${articulosList}${masTexto ? '\n' + masTexto : ''}`;
  }).join('\n\n');

  const title = `${assigned} artículo${assigned > 1 ? 's' : ''} asignado${assigned > 1 ? 's' : ''} automáticamente`;
  const message = `Los siguientes artículos fueron asignados:\n\n${groupsSummary}`;

  return createSyncNotification({
    businessId,
    userId,
    type: 'auto_assign',
    title,
    message,
    metadata: {
      total_assigned: assigned,
      groups: details.map(d => ({
        group_id: d.agrupacion_id,
        group_name: d.agrupacion_nombre,
        article_count: d.articulos_agregados,
        articles: d.articulos // 🆕 Ahora incluye { id, nombre }
      }))
    }
  });
}

module.exports = {
  createSyncNotification,
  notifyAutoAssign,
  getUserNotifications,
  markAsRead,
  markAllAsRead,
  getUnreadCount
};