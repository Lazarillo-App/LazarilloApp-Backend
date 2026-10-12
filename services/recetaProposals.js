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
const { logAudit } = require('./audit/auditLog');

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

/**
 * El payload que manda el front al guardar (RecetaModal/index.jsx) NUNCA
 * incluye el nombre del ingrediente — solo supplyId/articleRefId, porque el
 * guardado directo lo resuelve en writeArticleReceta/writeElaboradoReceta
 * via JOIN a insumos/maxi_articles. Una propuesta no pasa por ahí hasta que
 * se aprueba, así que sin esto la bandeja mostraba "(sin nombre)" en cada
 * ingrediente. Enriquece una COPIA de items con supplyNombre resuelto en
 * el momento — no afecta el guardado real al aprobar (ese sigue resolviendo
 * el nombre fresco desde la DB, ignora este campo).
 */
async function enrichItemsConNombre(items, bizId) {
  if (!Array.isArray(items) || !items.length) return items;

  const supplyIds = [...new Set(items.map(it => Number(it.supplyId)).filter(n => Number.isFinite(n) && n > 0))];
  const articleRefIds = [...new Set(items.map(it => Number(it.articleRefId)).filter(n => Number.isFinite(n) && n !== 0))];

  const nombresPorSupply = new Map();
  if (supplyIds.length) {
    const { rows } = await pool.query(
      `SELECT id, nombre FROM insumos WHERE id = ANY($1::int[])`, [supplyIds]
    );
    for (const r of rows) nombresPorSupply.set(Number(r.id), r.nombre);
  }

  const nombresPorArticleRef = new Map();
  const positivos = articleRefIds.filter(n => n > 0);
  const negativos = articleRefIds.filter(n => n < 0);
  if (positivos.length) {
    const { rows } = await pool.query(
      `SELECT articulo_id AS id, nombre FROM maxi_articles WHERE business_id = $1 AND articulo_id = ANY($2::int[])`,
      [bizId, positivos]
    );
    for (const r of rows) nombresPorArticleRef.set(Number(r.id), r.nombre);
  }
  if (negativos.length) {
    const { rows } = await pool.query(
      `SELECT id, name AS nombre FROM app_articles WHERE business_id = $1 AND id = ANY($2::int[])`,
      [bizId, negativos]
    );
    for (const r of rows) nombresPorArticleRef.set(Number(r.id), r.nombre);
  }

  return items.map(it => {
    const refId = Number(it.articleRefId);
    if (Number.isFinite(refId) && refId !== 0) {
      return { ...it, supplyNombre: nombresPorArticleRef.get(refId) || null };
    }
    const sId = Number(it.supplyId);
    return { ...it, supplyNombre: nombresPorSupply.get(sId) || null };
  });
}

async function createOrUpdateProposal({ bizId, articleId = null, insumoId = null, uid, body, snapshotBefore, nombreParaAviso }) {
  const sectorId = await resolveSectorId(uid, bizId);
  const bodyEnriquecido = { ...body, items: await enrichItemsConNombre(body.items, bizId) };
  const { rows: existingRows } = await pool.query(
    `SELECT id, receta_id FROM receta_proposals
      WHERE business_id = $1 AND created_by_user_id = $2 AND status = 'pending'
        AND (($3::int IS NOT NULL AND article_id = $3) OR ($4::int IS NOT NULL AND insumo_id = $4))
      LIMIT 1`,
    [bizId, uid, articleId, insumoId]
  );

  let row;
  let esNueva = false;
  if (existingRows.length) {
    const { rows } = await pool.query(
      `UPDATE receta_proposals
          SET payload_after = $1::jsonb, updated_at = NOW()
        WHERE id = $2
        RETURNING *`,
      [JSON.stringify(bodyEnriquecido), existingRows[0].id]
    );
    row = rows[0];
  } else {
    esNueva = true;
    const recetaId = snapshotBefore?.id || null;
    const { rows } = await pool.query(
      `INSERT INTO receta_proposals
         (business_id, receta_id, article_id, insumo_id, sector_id, created_by_user_id,
          status, payload_before, payload_after, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7::jsonb, $8::jsonb, NOW(), NOW())
       RETURNING *`,
      [bizId, recetaId, articleId, insumoId, sectorId, uid,
        snapshotBefore ? JSON.stringify(snapshotBefore) : null, JSON.stringify(bodyEnriquecido)]
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

  // Historial de actividad: antes esto no quedaba registrado para nada — un Staff
  // podía proponer cambios una y otra vez y su historial (Configuración > Historial
  // de actividad, filtrado por esa persona) no mostraba ni una fila. Se loguea bajo
  // el usuario que PROPONE (uid), no el admin que después decide (eso se audita
  // aparte en recetaProposalsController.js).
  logAudit(null, {
    userId: uid,
    businessId: bizId,
    entityType: 'receta_proposal',
    entityId: row.id,
    action: esNueva ? 'create' : 'update',
    diff: { after: { items: (bodyEnriquecido.items || []).length, rendimiento: bodyEnriquecido.porciones ?? null } },
    metadata: {
      estado: 'pendiente',
      nombre: nombreParaAviso || bodyEnriquecido.nombre || null,
      target: articleId ? 'articulo' : 'insumo',
      targetId: articleId || insumoId,
    },
  }).catch((e) => console.error('[recetaProposals] error en audit log:', e?.message));

  return row;
}


// Propuesta abierta (pending/in_revision) de una receta: el front la usa para marcar en gris lo no aprobado.
async function propuestaAbiertaDe(bizId, { articleId = null, insumoId = null } = {}) {
  const col = articleId ? 'article_id' : 'insumo_id';
  const val = articleId || insumoId;
  if (!val) return null;
  const { rows } = await pool.query(
    `SELECT id, status, payload_after, admin_comment, asignado_a_user_id,
            (SELECT COALESCE(name, email) FROM app_users WHERE id = receta_proposals.asignado_a_user_id) AS asignado_a_nombre
       FROM receta_proposals
      WHERE business_id = $1 AND ${col} = $2 AND status = ANY($3::text[])
      ORDER BY created_at DESC LIMIT 1`,
    [bizId, val, ['pending', 'in_revision']]
  );
  if (!rows.length) return null;
  const items = Array.isArray(rows[0].payload_after?.items) ? rows[0].payload_after.items : [];
  // "Marcada a revisión" (desde Sectores/Aprobaciones o el header de la receta) se
  // crea con payload_after = {} A PROPÓSITO — sin contenido todavía. El front la usa
  // para distinguir "hay un cambio de verdad esperando aprobación" (no tocar,
  // esperar) de "esto es solo un flag de revisar, podés seguir editando normal".
  const tieneContenido = rows[0].payload_after
    && typeof rows[0].payload_after === 'object'
    && Object.prototype.hasOwnProperty.call(rows[0].payload_after, 'items');
  return {
    id: rows[0].id,
    status: rows[0].status,
    items,
    tieneContenido,
    adminComment: rows[0].admin_comment || null,
    asignadoA: rows[0].asignado_a_nombre || null,
  };
}

/**
 * Cuando se guarda una receta DIRECTO (owner/admin, sin pasar por el circuito de
 * propuestas), cualquier propuesta pending/in_revision que siguiera abierta sobre
 * esa misma receta queda resuelta. Cubre dos casos reales:
 *  - Una "marcada a revisión" (payload_after={}, sin contenido) — antes nadie la
 *    cerraba nunca: quedaba en Aprobaciones para siempre aunque ya se hubiera
 *    corregido a mano, y bloqueaba volver a marcarla si hacía falta de nuevo.
 *  - Una propuesta real de un Staff que quedó obsoleta porque el admin/owner editó
 *    la receta directo mientras tanto (mismo criterio que ya usa approveProposal al
 *    aplicar una propuesta: las demás abiertas sobre la misma receta se cierran).
 */
async function resolverMarcasDeRevision({ bizId, articleId = null, insumoId = null, uid }) {
  const col = articleId ? 'article_id' : 'insumo_id';
  const val = articleId || insumoId;
  if (!val) return;
  try {
    await pool.query(
      `UPDATE receta_proposals
          SET status = 'rejected',
              admin_comment = CASE
                WHEN admin_comment IS NULL OR admin_comment = '' THEN 'Resuelta: la receta se editó y guardó directamente.'
                ELSE admin_comment || ' · Resuelta: la receta se editó y guardó directamente.'
              END,
              decided_at = NOW(), decided_by = $3, updated_at = NOW()
        WHERE business_id = $1 AND ${col} = $2 AND status IN ('pending', 'in_revision')`,
      [bizId, val, uid || null]
    );
    // Ya no queda ninguna abierta sobre esta receta — sacarle la marca de "tiene
    // propuesta pendiente" (si no, Aprobaciones/el badge de pendientes la seguían
    // contando aunque recién se hayan cerrado todas arriba).
    await pool.query(
      `UPDATE recetas SET has_pending_proposal = FALSE WHERE business_id = $1 AND ${col} = $2`,
      [bizId, val]
    );
  } catch (e) {
    console.error('[resolverMarcasDeRevision]', e?.message);
  }
}

module.exports = {
  propuestaAbiertaDe, snapshotReceta, snapshotRecetaElaborado, createOrUpdateProposal,
  enrichItemsConNombre, resolverMarcasDeRevision,
};
