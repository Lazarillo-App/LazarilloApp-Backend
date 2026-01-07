// routes/notifications.js
const express = require('express');
const router = express.Router();
const { authRequired } = require('../middleware/authMiddleware');
const notifService = require('../services/notificationService');

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

module.exports = router;