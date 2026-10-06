// controllers/recetaProposalsController.js
//
// Vista Operación — Fase 3: "Bandeja de aprobaciones". Un admin/owner revisa
// las propuestas que dejó un Staff (ver services/recetaProposals.js, donde
// se crean) y decide: aprobar (se aplica de verdad, vía services/recetaWrite.js
// — el mismo camino que usa un admin guardando directo), mandar a revisión
// (vuelve editable para quien la propuso, con un comentario) o rechazar.
'use strict';

const pool = require('../config/db');
const { getEffectiveRole } = require('../services/auth/accessControl');
const { writeArticleReceta, writeElaboradoReceta } = require('../services/recetaWrite');
const { createSyncNotification } = require('../services/notificationService');

async function requireAdminOrOwner(uid, bizId) {
  const role = await getEffectiveRole(uid, bizId);
  return role === 'admin' || role === 'owner';
}

/**
 * Costo aproximado de un payload (antes o después) sin tocar la DB — suma
 * cantidad×costoUnitario de los items y divide por el rendimiento. Es una
 * aproximación (no replica el puente porción/peso de calcCosto.js en el
 * front), pero alcanza para que el admin vea el impacto de un vistazo; el
 * costo real definitivo se recalcula en writeArticleReceta/writeElaboradoReceta
 * recién al aprobar.
 */
function computeCostoAprox(payload) {
  if (!payload) return null;
  const items = Array.isArray(payload.items) ? payload.items : [];
  const total = items.reduce((acc, it) => {
    const cant = Number(it.cantidad) || 0;
    const costoU = Number(it.costoUnitario ?? it.costo_unitario) || 0;
    return acc + cant * costoU;
  }, 0);
  const porciones = Math.max(0.001, Number(payload.porciones) || 1);
  const unidad = payload.rendimientoUnidad || payload.rendimiento_unidad || 'u';
  return { total, porUnidad: total / porciones, unidad };
}

/**
 * GET /businesses/:businessId/receta-proposals?status=pending,in_revision
 */
exports.listProposals = async (req, res, next) => {
  try {
    const bizId = Number(req.params.businessId);
    const uid = req.user?.id;
    if (!bizId) return res.status(400).json({ ok: false, error: 'invalid_params' });
    if (!(await requireAdminOrOwner(uid, bizId))) {
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }

    const statusParam = String(req.query.status || 'pending,in_revision')
      .split(',').map(s => s.trim()).filter(Boolean);

    const { rows } = await pool.query(
      `SELECT p.*,
              u.name AS created_by_name, u.email AS created_by_email,
              r.nombre AS receta_nombre_actual,
              s.nombre AS sector_nombre,
              i.nombre AS insumo_nombre,
              ma.nombre AS articulo_nombre
         FROM receta_proposals p
         LEFT JOIN app_users u ON u.id = p.created_by_user_id
         LEFT JOIN recetas r ON r.id = p.receta_id
         LEFT JOIN sectores s ON s.id = p.sector_id
         LEFT JOIN insumos i ON i.id = p.insumo_id AND i.business_id = p.business_id
         LEFT JOIN maxi_articles ma ON ma.articulo_id = p.article_id AND ma.business_id = p.business_id
        WHERE p.business_id = $1 AND p.status = ANY($2::text[])
        ORDER BY p.created_at DESC`,
      [bizId, statusParam]
    );

    // Avisar cuando hay más de una propuesta pendiente abierta sobre la misma receta/destino.
    const countByTarget = new Map();
    for (const r of rows) {
      const key = r.receta_id ? `r:${r.receta_id}` : (r.article_id ? `a:${r.article_id}` : `i:${r.insumo_id}`);
      countByTarget.set(key, (countByTarget.get(key) || 0) + 1);
    }
    const proposals = rows.map(r => {
      const key = r.receta_id ? `r:${r.receta_id}` : (r.article_id ? `a:${r.article_id}` : `i:${r.insumo_id}`);
      return {
        ...r,
        concurrentes: countByTarget.get(key),
        costo_antes: computeCostoAprox(r.payload_before),
        costo_despues: computeCostoAprox(r.payload_after),
      };
    });

    return res.json({ ok: true, proposals });
  } catch (e) {
    console.error('[listProposals]', e);
    next(e);
  }
};

/**
 * GET /businesses/:businessId/receta-proposals/:id
 */
exports.getProposal = async (req, res, next) => {
  try {
    const bizId = Number(req.params.businessId);
    const id = Number(req.params.id);
    const uid = req.user?.id;
    if (!bizId || !id) return res.status(400).json({ ok: false, error: 'invalid_params' });
    if (!(await requireAdminOrOwner(uid, bizId))) {
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }

    const { rows } = await pool.query(
      `SELECT p.*, u.name AS created_by_name, u.email AS created_by_email
         FROM receta_proposals p
         LEFT JOIN app_users u ON u.id = p.created_by_user_id
        WHERE p.id = $1 AND p.business_id = $2
        LIMIT 1`,
      [id, bizId]
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: 'proposal_not_found' });

    return res.json({ ok: true, proposal: rows[0] });
  } catch (e) {
    console.error('[getProposal]', e);
    next(e);
  }
};

async function loadPendingProposal(id, bizId) {
  const { rows } = await pool.query(
    `SELECT * FROM receta_proposals WHERE id = $1 AND business_id = $2 LIMIT 1`,
    [id, bizId]
  );
  return rows[0] || null;
}

/**
 * POST /businesses/:businessId/receta-proposals/:id/approve
 */
exports.approveProposal = async (req, res, next) => {
  try {
    const bizId = Number(req.params.businessId);
    const id = Number(req.params.id);
    const uid = req.user?.id;
    if (!bizId || !id) return res.status(400).json({ ok: false, error: 'invalid_params' });
    if (!(await requireAdminOrOwner(uid, bizId))) {
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }

    const proposal = await loadPendingProposal(id, bizId);
    if (!proposal) return res.status(404).json({ ok: false, error: 'proposal_not_found' });
    if (proposal.status === 'approved') {
      return res.status(409).json({ ok: false, error: 'already_approved' });
    }

    let result;
    if (proposal.article_id) {
      result = await writeArticleReceta({
        bizId, articleId: proposal.article_id, uid, body: proposal.payload_after,
      });
    } else if (proposal.insumo_id) {
      const { rows: insumoRows } = await pool.query(
        `SELECT id, nombre, unidad_med, es_elaborado, es_elaborado_manual
           FROM insumos WHERE id = $1 AND business_id = $2`,
        [proposal.insumo_id, bizId]
      );
      if (!insumoRows.length) return res.status(404).json({ ok: false, error: 'insumo_not_found' });
      result = await writeElaboradoReceta({
        bizId, insumoId: proposal.insumo_id, uid, body: proposal.payload_after, insumo: insumoRows[0],
      });
    } else {
      return res.status(400).json({ ok: false, error: 'proposal_without_target' });
    }

    const { rows: updatedRows } = await pool.query(
      `UPDATE receta_proposals
          SET status = 'approved', receta_id = $1, admin_comment = $2,
              decided_at = NOW(), decided_by = $3, updated_at = NOW()
        WHERE id = $4
        RETURNING *`,
      [result.receta.id, (req.body?.comment || '').trim() || null, uid, id]
    );

    // Cualquier otra propuesta pendiente/en revisión sobre la MISMA receta queda
    // marcada como rechazada automáticamente — ya no tiene sentido aplicarla sobre
    // la base vieja (mismo criterio que pide el plan: "marca las demás como
    // pendientes de decisión").
    await pool.query(
      `UPDATE receta_proposals
          SET status = 'rejected', admin_comment = COALESCE(admin_comment, 'Reemplazada por otra propuesta aprobada'),
              decided_at = NOW(), decided_by = $1, updated_at = NOW()
        WHERE business_id = $2 AND id <> $3 AND status IN ('pending','in_revision')
          AND ((article_id IS NOT NULL AND article_id = $4) OR (insumo_id IS NOT NULL AND insumo_id = $5))`,
      [uid, bizId, id, proposal.article_id, proposal.insumo_id]
    );

    // Solo a quien la propuso (no a todo el negocio) — quiere saber que su
    // cambio se aplicó, el resto del equipo no necesita enterarse de cada uno.
    createSyncNotification({
      businessId: bizId,
      userId: proposal.created_by_user_id,
      type: 'ui_action',
      title: 'Tu propuesta fue aprobada',
      message: 'Se aplicó el cambio que propusiste en la receta.',
      metadata: { kind: 'receta_proposal_approved', proposal_id: id },
    }).catch(() => {});

    return res.json({ ok: true, proposal: updatedRows[0], receta: result.receta });
  } catch (e) {
    console.error('[approveProposal]', e);
    next(e);
  }
};

/**
 * POST /businesses/:businessId/receta-proposals/:id/reject   body: { comment }
 */
exports.rejectProposal = async (req, res, next) => {
  try {
    const bizId = Number(req.params.businessId);
    const id = Number(req.params.id);
    const uid = req.user?.id;
    if (!bizId || !id) return res.status(400).json({ ok: false, error: 'invalid_params' });
    if (!(await requireAdminOrOwner(uid, bizId))) {
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }

    const proposal = await loadPendingProposal(id, bizId);
    if (!proposal) return res.status(404).json({ ok: false, error: 'proposal_not_found' });

    const { rows } = await pool.query(
      `UPDATE receta_proposals
          SET status = 'rejected', admin_comment = $1, decided_at = NOW(), decided_by = $2, updated_at = NOW()
        WHERE id = $3
        RETURNING *`,
      [(req.body?.comment || '').trim() || null, uid, id]
    );

    if (proposal.receta_id) {
      const { rows: stillPending } = await pool.query(
        `SELECT 1 FROM receta_proposals WHERE receta_id = $1 AND status IN ('pending','in_revision') LIMIT 1`,
        [proposal.receta_id]
      );
      if (!stillPending.length) {
        await pool.query(`UPDATE recetas SET has_pending_proposal = FALSE WHERE id = $1`, [proposal.receta_id]);
      }
    }

    createSyncNotification({
      businessId: bizId,
      userId: proposal.created_by_user_id,
      type: 'ui_action',
      title: 'Tu propuesta fue rechazada',
      message: req.body?.comment ? `Motivo: ${req.body.comment}` : 'Se rechazó el cambio que propusiste en la receta.',
      metadata: { kind: 'receta_proposal_rejected', proposal_id: id },
    }).catch(() => {});

    return res.json({ ok: true, proposal: rows[0] });
  } catch (e) {
    console.error('[rejectProposal]', e);
    next(e);
  }
};

/**
 * POST /businesses/:businessId/receta-proposals/:id/revision   body: { comment }
 * Vuelve editable para quien la propuso, con un motivo — no es un rechazo final.
 */
exports.requestRevision = async (req, res, next) => {
  try {
    const bizId = Number(req.params.businessId);
    const id = Number(req.params.id);
    const uid = req.user?.id;
    if (!bizId || !id) return res.status(400).json({ ok: false, error: 'invalid_params' });
    if (!(await requireAdminOrOwner(uid, bizId))) {
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }
    const comment = (req.body?.comment || '').trim();
    if (!comment) return res.status(400).json({ ok: false, error: 'comment_requerido' });

    const proposal = await loadPendingProposal(id, bizId);
    if (!proposal) return res.status(404).json({ ok: false, error: 'proposal_not_found' });

    const { rows } = await pool.query(
      `UPDATE receta_proposals
          SET status = 'in_revision', admin_comment = $1, updated_at = NOW()
        WHERE id = $2
        RETURNING *`,
      [comment, id]
    );

    createSyncNotification({
      businessId: bizId,
      userId: proposal.created_by_user_id,
      type: 'ui_action',
      title: 'Tu propuesta necesita un ajuste',
      message: comment,
      metadata: { kind: 'receta_proposal_revision', proposal_id: id },
    }).catch(() => {});

    return res.json({ ok: true, proposal: rows[0] });
  } catch (e) {
    console.error('[requestRevision]', e);
    next(e);
  }
};

/**
 * GET /businesses/:businessId/receta-proposals/mine — propuestas que creó el usuario actual
 * (cualquier estado), para que el staff vea qué pasó con sus cambios.
 */
exports.listMyProposals = async (req, res, next) => {
  try {
    const bizId = Number(req.params.businessId);
    const uid = req.user?.id;
    if (!bizId || !uid) return res.status(400).json({ ok: false, error: 'invalid_params' });
    const { rows } = await pool.query(
      `SELECT p.id, p.status, p.created_at, p.decided_at, p.admin_comment,
              p.receta_id, p.article_id, p.insumo_id,
              r.nombre AS receta_nombre_actual,
              i.nombre AS insumo_nombre,
              ma.nombre AS articulo_nombre
         FROM receta_proposals p
         LEFT JOIN recetas r ON r.id = p.receta_id
         LEFT JOIN insumos i ON i.id = p.insumo_id AND i.business_id = p.business_id
         LEFT JOIN maxi_articles ma ON ma.articulo_id = p.article_id AND ma.business_id = p.business_id
        WHERE p.business_id = $1 AND (p.created_by_user_id = $2 OR p.asignado_a_user_id = $2)
        ORDER BY p.created_at DESC
        LIMIT 100`,
      [bizId, uid]
    );
    return res.json({ ok: true, proposals: rows });
  } catch (e) { next(e); }
};

/**
 * POST /businesses/:businessId/receta-proposals/marcar-revision
 * Body: { items: [{ tipo: 'articulo'|'insumo', id }], comment }
 * Admin/owner marca una o más recetas/insumos para que alguien los revise, con una nota.
 */
exports.marcarRevision = async (req, res, next) => {
  try {
    const bizId = Number(req.params.businessId);
    const uid = req.user?.id;
    if (!bizId || !uid) return res.status(400).json({ ok: false, error: 'invalid_params' });
    if (!(await requireAdminOrOwner(uid, bizId))) return res.status(403).json({ ok: false, error: 'forbidden' });
    const comment = String(req.body?.comment || '').trim();
    if (!comment) return res.status(400).json({ ok: false, error: 'comment_required' });
    const asignadoA = Number(req.body?.asignadoA) || null;
    const items = (Array.isArray(req.body?.items) ? req.body.items : [])
      .map((it) => ({ tipo: it?.tipo === 'insumo' ? 'insumo' : 'articulo', id: Number(it?.id) }))
      .filter((it) => Number.isFinite(it.id) && it.id !== 0)
      .slice(0, 500);
    if (!items.length) return res.status(400).json({ ok: false, error: 'items_required' });

    let marcados = 0;
    for (const it of items) {
      const col = it.tipo === 'insumo' ? 'insumo_id' : 'article_id';
      const { rows: ya } = await pool.query(
        `SELECT 1 FROM receta_proposals WHERE business_id = $1 AND ${col} = $2 AND status = ANY($3::text[]) LIMIT 1`,
        [bizId, it.id, ['pending', 'in_revision']]
      );
      if (ya.length) continue;
      let recetaId = null;
      if (it.tipo === 'articulo') {
        const { rows: rr } = await pool.query(
          `SELECT id FROM recetas WHERE business_id = $1 AND article_id = $2 AND active = TRUE ORDER BY id DESC LIMIT 1`,
          [bizId, it.id]
        );
        recetaId = rr[0]?.id || null;
      }
      await pool.query(
        `INSERT INTO receta_proposals (business_id, receta_id, article_id, insumo_id, created_by_user_id, status, payload_before, payload_after, admin_comment, asignado_a_user_id)
         VALUES ($1, $2, $3, $4, $5, 'in_revision', NULL, '{}'::jsonb, $6, $7)`,
        [bizId, recetaId, it.tipo === 'articulo' ? it.id : null, it.tipo === 'insumo' ? it.id : null, uid, comment, asignadoA]
      );
      if (recetaId) await pool.query(`UPDATE recetas SET has_pending_proposal = TRUE WHERE id = $1`, [recetaId]);
      marcados++;
    }
    return res.json({ ok: true, marcados });
  } catch (e) { next(e); }
};
