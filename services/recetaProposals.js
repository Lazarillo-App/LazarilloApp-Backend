// services/recetaProposals.js
//
// Vista Operación — Fase 3: helpers de propuestas de receta.
// Cuando quien guarda es Staff, recetasController.js/recetasElaboradosController.js
// NO escriben la receta real — llaman acá para crear/actualizar una fila de
// `receta_proposals` con el snapshot de antes (payload_before) y lo que el
// Staff propone (payload_after, el mismo shape que ya manda el front al guardar).
// La receta real solo cambia cuando un admin/owner aprueba (ver
// recetaProposalsController.js, que sí usa recetaWrite.js para aplicarla).
'use strict';

const pool = require('../config/db');
const { createSyncNotificationForBusinessUsers } = require('./notificationService');

async function snapshotReceta(articleId, bizId) {
  const { rows: recetaRows } = await pool.query(
    `SELECT r.id, r.nombre, r.descripcion, r.porciones, r.porcentaje_venta,
            r.costo_total, r.notas, r.foto, r.fotos, r.notas_updated_at,
            r.rendimiento_unidad, r.rendimiento_peso, r.unidad_peso,
            r.metodo_coccion, r.temperatura, r.tiempo_min, r.pasos
       FROM recetas r
      WHERE r.article_id = $1 AND r.business_id = $2 AND r.active = TRUE
      LIMIT 1`,
    [articleId, bizId]
  );
  if (!recetaRows.length) return null;
  const receta = recetaRows[0];
  const { rows: items } = await pool.query(
    `SELECT ri.id, COALESCE(ri.insumo_id, ri.supply_id) AS supply_id,
            COALESCE(i.nombre, ma.nombre, ri.nombre_insumo_maxi) AS supply_nombre,
            ri.article_ref_id,
            ri.cantidad, ri.unidad, ri.costo_unitario, ri.notas, ri.observaciones,
            ri.merma, ri.pedido, ri.tipo_costo, ri.orden, ri.merma_id, ri.merma_ids, ri.secreto
       FROM receta_items ri
       LEFT JOIN insumos i ON i.id = ri.insumo_id
       LEFT JOIN maxi_articles ma ON ma.articulo_id = ri.article_ref_id AND ma.business_id = $2
      WHERE ri.receta_id = $1
      ORDER BY ri.orden ASC, ri.id ASC`,
    [receta.id, bizId]
  );
  return { ...receta, items };
}

async function snapshotRecetaElaborado(insumoId, bizId) {
  const { rows: recetaRows } = await pool.query(
    `SELECT r.id, r.nombre, r.descripcion, r.porciones, r.porcentaje_venta,
            r.costo_total, r.notas, r.foto, r.fotos, r.notas_updated_at,
            r.rendimiento_unidad, r.rendimiento_peso, r.unidad_peso,
            r.metodo_coccion, r.temperatura, r.tiempo_min, r.pasos
       FROM recetas r
      WHERE r.insumo_id = $1 AND r.business_id = $2 AND r.active = TRUE
      LIMIT 1`,
    [insumoId, bizId]
  );
  if (!recetaRows.length) return null;
  const receta = recetaRows[0];
  const { rows: items } = await pool.query(
    `SELECT ri.id, COALESCE(ri.insumo_id, ri.supply_id) AS supply_id,
            COALESCE(i.nombre, ma.nombre, ri.nombre_insumo_maxi) AS supply_nombre,
            ri.article_ref_id,
            ri.cantidad, ri.unidad, ri.costo_unitario, ri.notas, ri.observaciones,
            ri.merma, ri.pedido, ri.tipo_costo, ri.orden, ri.merma_id, ri.merma_ids, ri.secreto
       FROM receta_items ri
       LEFT JOIN insumos i ON i.id = ri.insumo_id
       LEFT JOIN maxi_articles ma ON ma.articulo_id = ri.article_ref_id AND ma.business_id = $2
      WHERE ri.receta_id = $1
      ORDER BY ri.orden ASC, ri.id ASC`,
    [receta.id, bizId]
  );
  return { ...receta, items };
}

/**
 * Crea una propuesta nueva, o pisa la propuesta PENDIENTE que el mismo Staff
 * ya tenía abierta para esta misma receta (evita acumular duplicados cada vez
 * que autoguarda o reintenta) — una propuesta "en revisión" o ya decidida NO
 * se pisa, queda su historial y se crea una nueva.
 */
async function resolveSectorId(uid, bizId) {
  const { rows } = await pool.query(
    `SELECT sector_ids FROM user_assignments
      WHERE user_id = $1 AND scope_type = 'business' AND scope_id = $2 AND revoked_at IS NULL
        AND sector_ids IS NOT NULL AND array_length(sector_ids, 1) > 0
      LIMIT 1`,
    [uid, bizId]
  );
  const ids = rows[0]?.sector_ids;
  return Array.isArray(ids) && ids.length ? ids[0] : null;
}

async function createOrUpdateProposal({ bizId, articleId = null, insumoId = null, uid, body, snapshotBefore, nombreParaAviso }) {
  const sectorId = await resolveSectorId(uid, bizId);
  const { rows: existingRows } = await pool.query(
    `SELECT id, receta_id FROM receta_proposals
      WHERE business_id = $1 AND created_by_user_id = $2 AND status = 'pending'
        AND (($3::int IS NOT NULL AND article_id = $3) OR ($4::int IS NOT NULL AND insumo_id = $4))
      LIMIT 1`,
    [bizId, uid, articleId, insumoId]
  );

  let row;
  if (existingRows.length) {
    const { rows } = await pool.query(
      `UPDATE receta_proposals
          SET payload_after = $1::jsonb, updated_at = NOW()
        WHERE id = $2
        RETURNING *`,
      [JSON.stringify(body), existingRows[0].id]
    );
    row = rows[0];
  } else {
    const recetaId = snapshotBefore?.id || null;
    const { rows } = await pool.query(
      `INSERT INTO receta_proposals
         (business_id, receta_id, article_id, insumo_id, sector_id, created_by_user_id,
          status, payload_before, payload_after, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7::jsonb, $8::jsonb, NOW(), NOW())
       RETURNING *`,
      [bizId, recetaId, articleId, insumoId, sectorId, uid,
        snapshotBefore ? JSON.stringify(snapshotBefore) : null, JSON.stringify(body)]
    );
    row = rows[0];

    if (recetaId) {
      await pool.query(`UPDATE recetas SET has_pending_proposal = TRUE WHERE id = $1`, [recetaId]);
    }

    // type 'ui_action' (siempre permitido) + kind en metadata — mismo criterio
    // defensivo que safeType() usa como fallback, sin arriesgar un tipo nuevo
    // contra un CHECK de DB que no podemos confirmar desde acá.
    createSyncNotificationForBusinessUsers({
      businessId: bizId,
      type: 'ui_action',
      title: 'Receta propuesta para revisar',
      message: `${nombreParaAviso || 'Un miembro del equipo'} propuso cambios en una receta. Andá a Configuración > Aprobaciones para revisarlos.`,
      metadata: { kind: 'receta_proposal', proposal_id: row.id },
      onlyAdmins: true,
    }).catch((e) => console.error('[recetaProposals] error notificando propuesta:', e?.message));
  }

  return row;
}

module.exports = { snapshotReceta, snapshotRecetaElaborado, createOrUpdateProposal };
