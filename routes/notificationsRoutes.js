// routes/notifications.js
const express = require('express');
const router = express.Router({ mergeParams: true });
const db = require('../config/db');
const { authRequired } = require('../middleware/authMiddleware');
const notifService = require('../services/notificationService');

// Helper para obtener businessId del parámetro
const getBusinessIdParam = (req) => {
  const bid = Number(req.params.businessId ?? req.params.id);
  if (!Number.isFinite(bid) || bid <= 0) return NaN;
  return bid;
};

// Helper para obtener userId (ajusta según tu sistema de auth)
const getUserId = (req) => req.user?.id || 1;

// GET /api/notifications - Listar notificaciones
router.get('/', authRequired, async (req, res, next) => {
  try {
    const userId = req.user?.id;
    const { business_id, limit = 20, unread_only } = req.query;

    const notifications = await notifService.getUserNotifications(userId, {
      businessId: business_id ? Number(business_id) : null,
      limit: Number(limit),
      unreadOnly: unread_only === 'true'
    });

    res.json({ ok: true, notifications });
  } catch (e) {
    next(e);
  }
});

// GET /api/notifications/unread-count - Contador de no leídas
router.get('/unread-count', authRequired, async (req, res, next) => {
  try {
    const userId = req.user?.id;
    const { business_id } = req.query;

    const count = await notifService.getUnreadCount(
      userId,
      business_id ? Number(business_id) : null
    );

    res.json({ ok: true, count });
  } catch (e) {
    next(e);
  }
});

// POST /api/notifications/mark-read - Marcar como leídas
router.post('/mark-read', authRequired, async (req, res, next) => {
  try {
    const userId = req.user?.id;
    const { notification_ids } = req.body;

    if (!Array.isArray(notification_ids)) {
      return res.status(400).json({ error: 'notification_ids debe ser un array' });
    }

    const result = await notifService.markAsRead(userId, notification_ids);
    res.json({ ok: true, ...result });
  } catch (e) {
    next(e);
  }
});

// POST /api/notifications/mark-all-read - Marcar todas como leídas
router.post('/mark-all-read', authRequired, async (req, res, next) => {
  try {
    const userId = req.user?.id;
    const { business_id } = req.body;

    const result = await notifService.markAllAsRead(
      userId,
      business_id ? Number(business_id) : null
    );

    res.json({ ok: true, ...result });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /businesses/:businessId/notifications
 * Lista notificaciones del negocio
 */
router.get('/', async (req, res, next) => {
  try {
    const businessId = getBusinessIdParam(req);
    if (!Number.isFinite(businessId)) {
      return res.status(400).json({ ok: false, error: 'invalid_business_id' });
    }

    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const offset = Number(req.query.offset) || 0;
    const onlyUnread = req.query.unread === 'true';

    let whereClause = 'WHERE business_id = $1';
    const params = [businessId];

    if (onlyUnread) {
      whereClause += ' AND read = false';
    }

    const { rows } = await db.query(`
      SELECT 
        id, 
        business_id, 
        type, 
        title, 
        message, 
        metadata, 
        read, 
        created_at
      FROM notifications
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `, [...params, limit, offset]);

    res.json({ 
      ok: true, 
      notifications: rows,
      count: rows.length,
      limit,
      offset
    });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /businesses/:businessId/notifications/unread-count
 * Cuenta notificaciones no leídas
 */
router.get('/unread-count', async (req, res, next) => {
  try {
    const businessId = getBusinessIdParam(req);
    if (!Number.isFinite(businessId)) {
      return res.status(400).json({ ok: false, error: 'invalid_business_id' });
    }

    const { rows } = await db.query(`
      SELECT COUNT(*)::int AS count
      FROM notifications
      WHERE business_id = $1 AND read = false
    `, [businessId]);

    res.json({ 
      ok: true, 
      count: rows[0]?.count || 0 
    });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /businesses/:businessId/notifications/mark-read
 * Marca notificaciones específicas como leídas
 */
router.post('/mark-read', async (req, res, next) => {
  try {
    const businessId = getBusinessIdParam(req);
    if (!Number.isFinite(businessId)) {
      return res.status(400).json({ ok: false, error: 'invalid_business_id' });
    }

    const { notification_ids } = req.body;
    
    if (!Array.isArray(notification_ids) || notification_ids.length === 0) {
      return res.status(400).json({ ok: false, error: 'notification_ids_required' });
    }

    // Validar que todos sean números
    const ids = notification_ids.map(id => Number(id)).filter(id => Number.isFinite(id) && id > 0);
    
    if (ids.length === 0) {
      return res.status(400).json({ ok: false, error: 'invalid_notification_ids' });
    }

    const result = await db.query(`
      UPDATE notifications
      SET read = true
      WHERE business_id = $1 
        AND id = ANY($2::bigint[])
        AND read = false
    `, [businessId, ids]);

    res.json({ 
      ok: true, 
      marked: result.rowCount || 0 
    });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /businesses/:businessId/notifications/mark-all-read
 * Marca TODAS las notificaciones del negocio como leídas
 */
router.post('/mark-all-read', async (req, res, next) => {
  try {
    const businessId = getBusinessIdParam(req);
    if (!Number.isFinite(businessId)) {
      return res.status(400).json({ ok: false, error: 'invalid_business_id' });
    }

    const result = await db.query(`
      UPDATE notifications
      SET read = true
      WHERE business_id = $1 
        AND read = false
    `, [businessId]);

    res.json({ 
      ok: true, 
      marked: result.rowCount || 0 
    });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /businesses/:businessId/notifications/:notificationId
 * Obtiene una notificación específica
 */
router.get('/:notificationId', async (req, res, next) => {
  try {
    const businessId = getBusinessIdParam(req);
    if (!Number.isFinite(businessId)) {
      return res.status(400).json({ ok: false, error: 'invalid_business_id' });
    }

    const notificationId = Number(req.params.notificationId);
    if (!Number.isFinite(notificationId) || notificationId <= 0) {
      return res.status(400).json({ ok: false, error: 'invalid_notification_id' });
    }

    const { rows } = await db.query(`
      SELECT 
        id, 
        business_id, 
        type, 
        title, 
        message, 
        metadata, 
        read, 
        created_at
      FROM notifications
      WHERE id = $1 AND business_id = $2
      LIMIT 1
    `, [notificationId, businessId]);

    if (rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'notification_not_found' });
    }

    res.json({ 
      ok: true, 
      notification: rows[0] 
    });
  } catch (e) {
    next(e);
  }
});

/**
 * DELETE /businesses/:businessId/notifications/:notificationId
 * Elimina una notificación (opcional)
 */
router.delete('/:notificationId', async (req, res, next) => {
  try {
    const businessId = getBusinessIdParam(req);
    if (!Number.isFinite(businessId)) {
      return res.status(400).json({ ok: false, error: 'invalid_business_id' });
    }

    const notificationId = Number(req.params.notificationId);
    if (!Number.isFinite(notificationId) || notificationId <= 0) {
      return res.status(400).json({ ok: false, error: 'invalid_notification_id' });
    }

    const result = await db.query(`
      DELETE FROM notifications
      WHERE id = $1 AND business_id = $2
    `, [notificationId, businessId]);

    if ((result.rowCount || 0) === 0) {
      return res.status(404).json({ ok: false, error: 'notification_not_found' });
    }

    res.json({ 
      ok: true, 
      deleted: true 
    });
  } catch (e) {
    next(e);
  }
});

module.exports = router;