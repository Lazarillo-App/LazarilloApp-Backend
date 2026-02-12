// routes/notificationsRoutes.js
const express = require('express');
const router = express.Router({ mergeParams: true });

const { authRequired } = require('../middleware/authMiddleware');
const notifService = require('../services/notificationService');

const getBusinessIdParam = (req) => {
  const bid = Number(req.params.businessId ?? req.params.id);
  if (!Number.isFinite(bid) || bid <= 0) return null;
  return bid;
};

const getLimit = (req, def = 20) => {
  const lim = Number(req.query.limit ?? def);
  return Math.min(Math.max(lim || def, 1), 200);
};

/**
 * GET /
 * - si está montado en /api/notifications -> lista por usuario (business opcional por query)
 * - si está montado en /api/businesses/:businessId/notifications -> fuerza businessId por params
 */
router.get('/', authRequired, async (req, res, next) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ ok: false, error: 'unauthorized' });

    const businessIdFromParams = getBusinessIdParam(req);
    const businessIdFromQuery = req.query.business_id ? Number(req.query.business_id) : null;

    const businessId =
      businessIdFromParams ??
      (Number.isFinite(businessIdFromQuery) && businessIdFromQuery > 0 ? businessIdFromQuery : null);

    const unreadOnly = String(req.query.unread_only ?? 'false') === 'true';

    const notifications = await notifService.getUserNotifications(userId, {
      businessId,
      limit: getLimit(req, 20),
      unreadOnly,
    });

    res.json({ ok: true, notifications });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /unread-count
 */
router.get('/unread-count', authRequired, async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ ok: false, error: 'unauthorized' });

    const businessIdFromParams = getBusinessIdParam(req);
    const businessIdFromQuery = req.query.business_id ? Number(req.query.business_id) : null;

    const businessId =
      businessIdFromParams ??
      (Number.isFinite(businessIdFromQuery) && businessIdFromQuery > 0 ? businessIdFromQuery : null);

    const count = await notifService.getUnreadCount(userId, businessId);
    return res.json({ ok: true, count });
  } catch (e) {
    console.error('[notificationsRoutes] unread-count error:', e);
    return res.json({ ok: true, count: 0 }); // ✅ fallback
  }
});

/**
 * POST /
 * body: { type?: 'ui_action', title: string, message?: string, metadata?: object }
 * Nota: por seguridad, desde front solo permitimos ui_action
 */
router.post('/', authRequired, async (req, res, next) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ ok: false, error: 'unauthorized' });

    const businessId = getBusinessIdParam(req);
    if (!businessId) return res.status(400).json({ ok: false, error: 'invalid_business_id' });

    const { title, message, metadata, type } = req.body || {};

    const ttl = String(title || '').trim();
    if (!ttl) return res.status(400).json({ ok: false, error: 'title_required' });

    // ✅ solo permitimos ui_action desde UI
    const finalType = String(type || 'ui_action').trim();
    if (finalType !== 'ui_action') {
      return res.status(400).json({ ok: false, error: 'type_not_allowed' });
    }

    const created = await notifService.createSyncNotification({
      businessId,
      userId,
      type: 'ui_action',
      title: ttl,
      message: message == null ? null : String(message),
      metadata: (metadata && typeof metadata === 'object') ? metadata : {},
    });

    return res.json({ ok: true, notification: created });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /mark-read
 * body: { notification_ids: number[] }
 */
router.post('/mark-read', authRequired, async (req, res, next) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ ok: false, error: 'unauthorized' });

    const { notification_ids } = req.body || {};
    if (!Array.isArray(notification_ids)) {
      return res.status(400).json({ ok: false, error: 'notification_ids_must_be_array' });
    }

    const result = await notifService.markAsRead(userId, notification_ids);
    res.json({ ok: true, ...result });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /mark-all-read
 * body: { business_id?: number }
 * - si está montado en /api/businesses/:businessId/notifications, ignora business_id del body
 */
router.post('/mark-all-read', authRequired, async (req, res, next) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ ok: false, error: 'unauthorized' });

    const businessIdFromParams = getBusinessIdParam(req);
    const businessIdFromBody = req.body?.business_id ? Number(req.body.business_id) : null;

    const businessId =
      businessIdFromParams ??
      (Number.isFinite(businessIdFromBody) && businessIdFromBody > 0 ? businessIdFromBody : null);

    const result = await notifService.markAllAsRead(userId, businessId);
    res.json({ ok: true, ...result });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
