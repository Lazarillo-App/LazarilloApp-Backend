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

/**
 * ✅ Resuelve/cierra las notificaciones asociadas a un changeSetId:
 * - read=true
 * - metadata.resolution.status = applied|rejected|approved
 *
 * Nota: asume metadata JSONB. Si tu columna es JSON (no JSONB), te digo abajo el ajuste.
 */
async function resolveNotificationsForChangeSet({ businessId, changeSetId, userId, resolutionStatus }) {
  // resolutionStatus: 'applied' | 'rejected'

  const q = `
    UPDATE notifications
    SET
      read = true,
      metadata = (
        CASE
          WHEN pg_typeof(metadata) = 'jsonb'::regtype THEN
            jsonb_set(
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
          ELSE
            (
              jsonb_set(
                COALESCE(metadata::jsonb, '{}'::jsonb),
                '{resolution}',
                to_jsonb(json_build_object(
                  'status', $3,
                  'at', now(),
                  'by', $4,
                  'change_set_id', $2
                )),
                true
              )
            )::json
        END
      )
    WHERE business_id = $1
      AND (metadata->>'change_set_id') = $2::text
  `;

  const r = await db.query(q, [businessId, String(changeSetId), resolutionStatus, userId || null]);
  return r.rowCount || 0;
}

async function createOutcomeNotification({ businessId, changeSetId, scope, type, title, message, metadata }) {
  await db.query(
    `
    INSERT INTO notifications (business_id, type, title, message, metadata, read, created_at)
    VALUES ($1, $2, $3, $4, $5::jsonb, false, now())
    `,
    [
      businessId,
      type,
      title,
      message,
      JSON.stringify({
        change_set_id: String(changeSetId),
        scope,
        ...(metadata || {}),
      }),
    ]
  );
}

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

    // ✅ marcar notificación como "approved" (opcional, pero te ayuda a que el front no la “reviva”)
    await resolveNotificationsForChangeSet({
      businessId,
      changeSetId,
      userId,
      resolutionStatus: 'approved',
    });

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

    // ✅ Cierra notificación original
    await resolveNotificationsForChangeSet({
      businessId,
      changeSetId,
      userId,
      resolutionStatus: 'rejected',
    });
    console.log('[sync] resolved notifications', { businessId, changeSetId, affected });

    // ✅ Opcional: notificación de resultado
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
      resolutionStatus: 'applied',
    });
    console.log('[sync] resolved notifications', { businessId, changeSetId, affected });

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
