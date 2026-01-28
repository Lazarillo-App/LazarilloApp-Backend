// routes/syncRoutes.js
const express = require('express');
const router = express.Router({ mergeParams: true });

const { detectInsumosChanges } = require('../services/syncInsumosDetectService');
const { applyInsumosChangeSet } = require('../services/syncChangeSetApplyService');

const db = require('../config/db');

// Helpers auth
const getUserId = (req) => req.user?.id || 1;

// ✅ Soporta ambos montajes:
// - app.use('/api/businesses/:businessId', syncRoutes)
// - router.use('/:id/sync', syncRoutes)
const getBusinessIdParam = (req) => {
  const bid = Number(req.params.businessId ?? req.params.id);
  if (!Number.isFinite(bid) || bid <= 0) return NaN;
  return bid;
};

const resolveNotificationsForChangeSet = async ({ businessId, changeSetId, userId, resolutionStatus }) => {
  // Nota: metadata puede ser json o jsonb según tu tabla. Asumo jsonb.
  // Si es json, te digo abajo el ajuste.
  await db.query(`
    UPDATE notifications
    SET
      read = true,
      metadata = jsonb_set(
        COALESCE(metadata, '{}'::jsonb),
        '{resolution}',
        to_jsonb(json_build_object(
          'status', $3,
          'at', now(),
          'by', $4
        )),
        true
      )
    WHERE business_id = $1
      AND NULLIF(metadata->>'change_set_id', '')::int = $2
  `, [businessId, changeSetId, resolutionStatus, userId]);
};

const createOutcomeNotification = async ({ businessId, changeSetId, scope, type, title, message, metadata }) => {
  await db.query(`
    INSERT INTO notifications (business_id, type, title, message, metadata, read, created_at)
    VALUES ($1, $2, $3, $4, $5::jsonb, false, now())
  `, [
    businessId,
    type,
    title,
    message,
    JSON.stringify({
      change_set_id: String(changeSetId),
      scope,
      ...(metadata || {}),
    }),
  ]);
};

/* ========================= INSUMOS ========================= */

// Detect insumos
router.post('/insumos/detect', async (req, res, next) => {
  try {
    const businessId = getBusinessIdParam(req);
    if (!Number.isFinite(businessId)) {
      return res.status(400).json({ ok: false, error: 'invalid_business_id' });
    }

    const userId = getUserId(req);
    const out = await detectInsumosChanges({ businessId, userId, req });
    res.json(out);
  } catch (e) { next(e); }
});

/* ========================= CHANGE SETS ========================= */

// List change sets
router.get('/change-sets', async (req, res, next) => {
  try {
    const businessId = getBusinessIdParam(req);
    if (!Number.isFinite(businessId)) {
      return res.status(400).json({ ok: false, error: 'invalid_business_id' });
    }

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
  } catch (e) { next(e); }
});

// Get details
router.get('/change-sets/:changeSetId', async (req, res, next) => {
  try {
    const businessId = getBusinessIdParam(req);
    if (!Number.isFinite(businessId)) {
      return res.status(400).json({ ok: false, error: 'invalid_business_id' });
    }

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
  } catch (e) { next(e); }
});

// Approve
router.post('/change-sets/:changeSetId/approve', async (req, res, next) => {
  try {
    const businessId = getBusinessIdParam(req);
    if (!Number.isFinite(businessId)) {
      return res.status(400).json({ ok: false, error: 'invalid_business_id' });
    }

    const changeSetId = Number(req.params.changeSetId);
    if (!Number.isFinite(changeSetId) || changeSetId <= 0) {
      return res.status(400).json({ ok: false, error: 'invalid_change_set_id' });
    }

    const userId = getUserId(req);

    const r = await db.query(`
      UPDATE sync_change_sets
      SET status='approved', approved_by=$3, approved_at=now()
      WHERE id=$1 AND business_id=$2 AND status IN ('pending','error')
    `, [changeSetId, businessId, userId]);

    if ((r.rowCount || 0) === 0) {
      return res.status(404).json({ ok: false, error: 'change_set_not_found_or_not_approvable' });
    }

    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Reject
router.post('/change-sets/:changeSetId/reject', async (req, res, next) => {
  try {
    const businessId = getBusinessIdParam(req);
    if (!Number.isFinite(businessId)) {
      return res.status(400).json({ ok: false, error: 'invalid_business_id' });
    }

    const changeSetId = Number(req.params.changeSetId);
    if (!Number.isFinite(changeSetId) || changeSetId <= 0) {
      return res.status(400).json({ ok: false, error: 'invalid_change_set_id' });
    }

    const userId = getUserId(req);

    const r = await db.query(`
      UPDATE sync_change_sets
      SET status='rejected', approved_by=$3, approved_at=now()
      WHERE id=$1 AND business_id=$2 AND status IN ('pending','error','approved')
    `, [changeSetId, businessId, userId]);

    if ((r.rowCount || 0) === 0) {
      return res.status(404).json({ ok: false, error: 'change_set_not_found_or_not_rejectable' });
    }

    // ✅ Cierra la notificación original (ya no es accionable nunca)
    await resolveNotificationsForChangeSet({
      businessId,
      changeSetId,
      userId,
      resolutionStatus: 'rejected'
    });

    // ✅ Opcional: generar notificación de resultado
    await createOutcomeNotification({
      businessId,
      changeSetId,
      scope: 'insumos',
      type: 'sync_insumos_rejected',
      title: 'Cambios rechazados (Insumos)',
      message: `Se rechazó el change set #${changeSetId}. No se aplicaron cambios.`,
      metadata: { outcome: 'rejected' },
    });

    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Apply
router.post('/change-sets/:changeSetId/apply', async (req, res, next) => {
  try {
    const businessId = getBusinessIdParam(req);
    if (!Number.isFinite(businessId)) {
      return res.status(400).json({ ok: false, error: 'invalid_business_id' });
    }

    const changeSetId = Number(req.params.changeSetId);
    if (!Number.isFinite(changeSetId) || changeSetId <= 0) {
      return res.status(400).json({ ok: false, error: 'invalid_change_set_id' });
    }

    const userId = getUserId(req);

    const out = await applyInsumosChangeSet({ businessId, changeSetId, userId });

    // ✅ Cierra notificación original
    await resolveNotificationsForChangeSet({
      businessId,
      changeSetId,
      userId,
      resolutionStatus: 'applied'
    });

    // ✅ Opcional: notificación de éxito con resumen
    const counts = out?.summary?.counts || out?.item?.summary?.counts || {};
    const msg = `Aplicado change set #${changeSetId}. Nuevos: ${counts.new ?? '-'}, Actualizados: ${counts.updated ?? '-'}, Faltantes: ${counts.missing ?? '-'}.`;

    await createOutcomeNotification({
      businessId,
      changeSetId,
      scope: 'insumos',
      type: 'sync_insumos_applied',
      title: 'Cambios aplicados correctamente (Insumos)',
      message: msg,
      metadata: { outcome: 'applied', counts },
    });

    res.json(out);
  } catch (e) { next(e); }
});

module.exports = router;
