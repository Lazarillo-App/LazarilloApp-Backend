// routes/syncRoutes.js
const express = require('express');
const router = express.Router({ mergeParams: true });

const { authRequired } = require('../middleware/authMiddleware');

const { detectInsumosChanges } = require('../services/syncInsumosDetectService');
const { applyInsumosChangeSet } = require('../services/syncChangeSetApplyService');
const { applySalesImportChangeSet } = require('../services/salesImportChangeSetApplyService');

const db = require('../config/db');
const notifService = require('../services/notificationService');

// ✅ helpers
const getUserId = (req) => req.user?.id || null;

const getBusinessIdParam = (req) => {
  const bid = Number(req.params.businessId ?? req.params.id);
  if (!Number.isFinite(bid) || bid <= 0) return NaN;
  return bid;
};

// ✅ proteger todo el router
router.use(authRequired);

/**
 * ✅ Resuelve/cierra notificaciones en sync_notifications asociadas a changeSetId
 */
async function resolveSyncNotificationsForChangeSet({ businessId, changeSetId, userId, resolutionStatus }) {
  const q = `
    UPDATE sync_notifications
    SET
      read = true,
      metadata = jsonb_set(
        COALESCE(metadata, '{}'::jsonb),
        '{resolution}',
        to_jsonb(json_build_object(
          'status', $3,
          'at', now(),
          'by', $4,
          'change_set_id', $2
        )),
        true
      )
    WHERE business_id = $1
      AND (metadata->>'change_set_id') = $2::text
  `;

  try {
    const r = await db.query(q, [businessId, String(changeSetId), resolutionStatus, userId || null]);
    return r.rowCount || 0;
  } catch (error) {
    console.error('[resolveSyncNotificationsForChangeSet] Error:', error);
    return 0;
  }
}

/**
 * ✅ Outcome usando notificationService (consistencia total)
 */
async function createOutcome({ businessId, userId, scope, changeSetId, outcome, message, extraMeta = {} }) {
  // type coherente (sin inventar demasiados)
  const type =
    scope === 'sales_import' ? 'sync_sales' :
    scope === 'insumos' ? 'sync_articles' : // o 'error' si no querés mezclar
    'error';

  const title =
    outcome === 'applied' ? 'Cambio aplicado' :
    outcome === 'rejected' ? 'Cambio rechazado' :
    outcome === 'approved' ? 'Cambio aprobado' :
    'Cambio actualizado';

  return notifService.createSyncNotification({
    businessId,
    userId,
    type,
    title,
    message: message || null,
    metadata: {
      scope,
      change_set_id: String(changeSetId),
      outcome,
      ...extraMeta,
    },
  });
}

/* ========================= INSUMOS ========================= */

router.post('/insumos/detect', async (req, res, next) => {
  try {
    const businessId = getBusinessIdParam(req);
    if (!Number.isFinite(businessId)) return res.status(400).json({ ok: false, error: 'invalid_business_id' });

    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: 'unauthorized' });

    const out = await detectInsumosChanges({ businessId, userId, req });
    res.json(out);
  } catch (e) {
    next(e);
  }
});

/* ========================= CHANGE SETS ========================= */

router.get('/change-sets', async (req, res, next) => {
  try {
    const businessId = getBusinessIdParam(req);
    if (!Number.isFinite(businessId)) return res.status(400).json({ ok: false, error: 'invalid_business_id' });

    const status = req.query.status || null;
    const scope = req.query.scope || null;

    const params = [businessId];
    let w = 'WHERE business_id = $1';
    if (status) { params.push(status); w += ` AND status = $${params.length}`; }
    if (scope) { params.push(scope); w += ` AND scope = $${params.length}`; }

    const { rows } = await db.query(`
      SELECT id, scope, status, summary, created_at, approved_at, applied_at
      FROM sync_change_sets
      ${w}
      ORDER BY created_at DESC
      LIMIT 50
    `, params);

    res.json({ ok: true, rows });
  } catch (e) {
    next(e);
  }
});

router.get('/change-sets/:changeSetId', async (req, res, next) => {
  try {
    const businessId = getBusinessIdParam(req);
    if (!Number.isFinite(businessId)) return res.status(400).json({ ok: false, error: 'invalid_business_id' });

    const changeSetId = Number(req.params.changeSetId);
    if (!Number.isFinite(changeSetId) || changeSetId <= 0) {
      return res.status(400).json({ ok: false, error: 'invalid_change_set_id' });
    }

    const { rows } = await db.query(`
      SELECT *
      FROM sync_change_sets
      WHERE id = $1 AND business_id = $2
      LIMIT 1
    `, [changeSetId, businessId]);

    res.json({ ok: true, item: rows[0] || null });
  } catch (e) {
    next(e);
  }
});

router.post('/change-sets/:changeSetId/approve', async (req, res, next) => {
  try {
    const businessId = getBusinessIdParam(req);
    if (!Number.isFinite(businessId)) return res.status(400).json({ ok: false, error: 'invalid_business_id' });

    const changeSetId = Number(req.params.changeSetId);
    if (!Number.isFinite(changeSetId) || changeSetId <= 0) {
      return res.status(400).json({ ok: false, error: 'invalid_change_set_id' });
    }

    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: 'unauthorized' });

    const r = await db.query(`
      UPDATE sync_change_sets
      SET status='approved', approved_by=$3, approved_at=now()
      WHERE id=$1 AND business_id=$2 AND status IN ('pending','error')
    `, [changeSetId, businessId, userId]);

    if ((r.rowCount || 0) === 0) {
      return res.status(404).json({ ok: false, error: 'change_set_not_found_or_not_approvable' });
    }

    const affected = await resolveSyncNotificationsForChangeSet({
      businessId,
      changeSetId,
      userId,
      resolutionStatus: 'approved',
    });

    res.json({ ok: true, notificationsResolved: affected });
  } catch (e) {
    next(e);
  }
});

router.post('/change-sets/:changeSetId/reject', async (req, res, next) => {
  try {
    const businessId = getBusinessIdParam(req);
    if (!Number.isFinite(businessId)) return res.status(400).json({ ok: false, error: 'invalid_business_id' });

    const changeSetId = Number(req.params.changeSetId);
    if (!Number.isFinite(changeSetId) || changeSetId <= 0) {
      return res.status(400).json({ ok: false, error: 'invalid_change_set_id' });
    }

    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: 'unauthorized' });

    const r = await db.query(`
      UPDATE sync_change_sets
      SET status='rejected', approved_by=$3, approved_at=now()
      WHERE id=$1 AND business_id=$2 AND status IN ('pending','error','approved')
    `, [changeSetId, businessId, userId]);

    if ((r.rowCount || 0) === 0) {
      return res.status(404).json({ ok: false, error: 'change_set_not_found_or_not_rejectable' });
    }

    const affected = await resolveSyncNotificationsForChangeSet({
      businessId,
      changeSetId,
      userId,
      resolutionStatus: 'rejected',
    });

    // leer scope para outcome correcto
    const { rows: [cs] } = await db.query(
      `SELECT scope FROM sync_change_sets WHERE id=$1 AND business_id=$2 LIMIT 1`,
      [changeSetId, businessId]
    );

    await createOutcome({
      businessId,
      userId,
      scope: cs?.scope || 'unknown',
      changeSetId,
      outcome: 'rejected',
      message: `Se rechazó el change set #${changeSetId}. No se aplicaron cambios.`,
    });

    res.json({ ok: true, notificationsResolved: affected });
  } catch (e) {
    next(e);
  }
});

router.post('/change-sets/:changeSetId/apply', async (req, res, next) => {
  try {
    const businessId = getBusinessIdParam(req);
    if (!Number.isFinite(businessId)) return res.status(400).json({ ok: false, error: 'invalid_business_id' });

    const changeSetId = Number(req.params.changeSetId);
    if (!Number.isFinite(changeSetId) || changeSetId <= 0) {
      return res.status(400).json({ ok: false, error: 'invalid_change_set_id' });
    }

    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: 'unauthorized' });

    const { rows: [cs] } = await db.query(
      `SELECT id, scope, status, summary FROM sync_change_sets WHERE id=$1 AND business_id=$2 LIMIT 1`,
      [changeSetId, businessId]
    );

    if (!cs) return res.status(404).json({ ok: false, error: 'change_set_not_found' });

    let out;
    if (cs.scope === 'insumos') {
      out = await applyInsumosChangeSet({ businessId, changeSetId, userId });
    } else if (cs.scope === 'sales_import') {
      out = await applySalesImportChangeSet({ businessId, changeSetId, userId });
    } else {
      return res.status(400).json({ ok: false, error: 'unsupported_scope', scope: cs.scope });
    }

    const affected = await resolveSyncNotificationsForChangeSet({
      businessId,
      changeSetId,
      userId,
      resolutionStatus: 'applied',
    });

    await createOutcome({
      businessId,
      userId,
      scope: cs.scope,
      changeSetId,
      outcome: 'applied',
      message: `Se aplicó el change set #${changeSetId}.`,
      extraMeta: { result: out },
    });

    res.json({ ...out, notificationsResolved: affected });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
