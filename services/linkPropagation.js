// services/linkPropagation.js
//
// Helper compartido que usan recetasController y articlePriceConfigController.
// Detecta si un artículo está vinculado y replica el cambio a los demás miembros.

'use strict';

const pool = require('../config/db');

/**
 * Obtiene los miembros de la vinculación de un artículo (excluyendo al propio artículo).
 * Devuelve null si el artículo no está vinculado.
 */
async function getLinkSiblings(bizId, articleId) {
  const { rows } = await pool.query(
    `SELECT m2.article_id, g.id AS group_id, g.name AS group_name,
            g.sync_recipe, g.sync_objetivo, g.sync_precio
       FROM article_link_members m
       JOIN article_link_groups g ON g.id = m.link_group_id
       JOIN article_link_members m2 ON m2.link_group_id = g.id
      WHERE m.article_id = $1 AND m.business_id = $2
        AND m2.article_id != $1`,
    [articleId, bizId]
  );
  if (!rows.length) return null;
  return rows; // [{ article_id, group_id, group_name, sync_recipe, sync_objetivo, sync_precio }]
}

/**
 * Registra la propagación en el log (tabla article_link_propagations).
 */
async function logPropagation(client, { groupId, bizId, triggeredBy, propagatedTo, changeType, changeDetail }) {
  try {
    await client.query(
      `INSERT INTO article_link_propagations
         (link_group_id, business_id, triggered_by, propagated_to, change_type, change_detail)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [groupId, bizId, triggeredBy, propagatedTo, changeType, JSON.stringify(changeDetail || {})]
    );
  } catch (e) {
    // Log no es crítico, no romper el flujo principal
    console.warn('[linkPropagation] Error al loguear propagación:', e.message);
  }
}

/**
 * Propaga una RECETA a todos los artículos vinculados.
 * Copia los items de la receta del artículo origen a cada sibling.
 *
 * @param {object} opts
 * @param {number} opts.bizId
 * @param {number} opts.articleId     — artículo que disparó el cambio
 * @param {object} opts.receta        — receta guardada (con .id, .costo_total, .porciones, etc.)
 * @param {object[]} opts.savedItems  — items de la receta guardada
 */
async function propagateRecipe({ bizId, articleId, receta, savedItems }) {
  const siblings = await getLinkSiblings(bizId, articleId);
  if (!siblings) return;

  // Filtrar solo los que tienen sync_recipe activo
  const targets = siblings.filter(s => s.sync_recipe !== false);
  if (!targets.length) return;

  const groupId   = targets[0].group_id;
  const groupName = targets[0].group_name;
  const propagatedTo = targets.map(s => Number(s.article_id));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const sibling of targets) {
      const siblingId = Number(sibling.article_id);

      // Upsert receta del sibling (mismos datos, distinto article_id)
      const { rows: recetaRows } = await client.query(
        `INSERT INTO recetas
           (article_id, business_id, nombre, descripcion, porciones,
            porcentaje_venta, costo_total, active, origen, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, 'linked', NOW())
         ON CONFLICT (article_id, business_id)
         DO UPDATE SET
           nombre           = EXCLUDED.nombre,
           descripcion      = EXCLUDED.descripcion,
           porciones        = EXCLUDED.porciones,
           porcentaje_venta = EXCLUDED.porcentaje_venta,
           costo_total      = EXCLUDED.costo_total,
           active           = TRUE,
           origen           = 'linked',
           updated_at       = NOW()
         RETURNING id`,
        [
          siblingId, bizId,
          receta.nombre || null,
          receta.descripcion || null,
          receta.porciones || 1,
          receta.porcentaje_venta || 0,
          receta.costo_total,
        ]
      );

      const siblingRecetaId = recetaRows[0].id;

      // Reemplazar items
      await client.query(`DELETE FROM receta_items WHERE receta_id = $1`, [siblingRecetaId]);

      for (const item of savedItems || []) {
        const insumoId = Number(item.insumo_id ?? item.supply_id);
        if (!Number.isFinite(insumoId) || insumoId <= 0) continue;

        await client.query(
          `INSERT INTO receta_items
             (receta_id, insumo_id, cantidad, unidad, costo_unitario, notas,
              observaciones, merma, pedido, tipo_costo, orden, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), NOW())`,
          [
            siblingRecetaId,
            insumoId,
            item.cantidad,
            item.unidad || null,
            item.costo_unitario,
            item.notas || null,
            item.observaciones || null,
            item.merma !== false,
            item.pedido !== false,
            item.tipo_costo || 'total',
            item.orden ?? 0,
          ]
        );
      }

      console.log(`[propagateRecipe] Receta copiada → artículo ${siblingId} (grupo "${groupName}")`);
    }

    // Log de propagación
    await logPropagation(client, {
      groupId,
      bizId,
      triggeredBy: articleId,
      propagatedTo,
      changeType: 'recipe',
      changeDetail: { costo_total: receta.costo_total, items_count: (savedItems || []).length },
    });

    await client.query('COMMIT');

    console.log(`✅ [propagateRecipe] ${propagatedTo.length} artículos actualizados desde artículo ${articleId}`);
    return { propagatedTo, count: propagatedTo.length };

  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('[propagateRecipe] Error:', e.message);
    return null;
  } finally {
    client.release();
  }
}

/**
 * Propaga un PRECIO MANUAL a todos los artículos vinculados.
 *
 * @param {object} opts
 * @param {number} opts.bizId
 * @param {number} opts.articleId
 * @param {number} opts.precioManual
 */
async function propagatePrecioManual({ bizId, articleId, precioManual }) {
  const siblings = await getLinkSiblings(bizId, articleId);
  if (!siblings) return;

  const targets = siblings.filter(s => s.sync_precio !== false);
  if (!targets.length) return;

  const groupId      = targets[0].group_id;
  const propagatedTo = targets.map(s => Number(s.article_id));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const sibling of targets) {
      const siblingId = Number(sibling.article_id);
      await client.query(
        `INSERT INTO article_price_config
           (business_id, scope, scope_id, precio_manual, updated_at)
         VALUES ($1, 'articulo', $2, $3, NOW())
         ON CONFLICT (business_id, scope, scope_id)
         DO UPDATE SET
           precio_manual = EXCLUDED.precio_manual,
           updated_at    = NOW()`,
        [bizId, String(siblingId), precioManual]
      );
    }

    await logPropagation(client, {
      groupId,
      bizId,
      triggeredBy: articleId,
      propagatedTo,
      changeType: 'precio_manual',
      changeDetail: { precioManual },
    });

    await client.query('COMMIT');

    console.log(`✅ [propagatePrecioManual] precio_manual=${precioManual} → ${propagatedTo.length} artículos desde artículo ${articleId}`);
    return { propagatedTo, count: propagatedTo.length };

  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('[propagatePrecioManual] Error:', e.message);
    return null;
  } finally {
    client.release();
  }
}

/**
 * Propaga un OBJETIVO % a todos los artículos vinculados.
 *
 * @param {object} opts
 * @param {number} opts.bizId
 * @param {number} opts.articleId
 * @param {number} opts.objetivo
 */
async function propagateObjetivo({ bizId, articleId, objetivo }) {
  const siblings = await getLinkSiblings(bizId, articleId);
  if (!siblings) return;

  const targets = siblings.filter(s => s.sync_objetivo !== false);
  if (!targets.length) return;

  const groupId      = targets[0].group_id;
  const propagatedTo = targets.map(s => Number(s.article_id));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const sibling of targets) {
      const siblingId = Number(sibling.article_id);
      await client.query(
        `INSERT INTO article_price_config
           (business_id, scope, scope_id, objetivo_pct, updated_at)
         VALUES ($1, 'articulo', $2, $3, NOW())
         ON CONFLICT (business_id, scope, scope_id)
         DO UPDATE SET
           objetivo_pct = EXCLUDED.objetivo_pct,
           updated_at   = NOW()`,
        [bizId, String(siblingId), objetivo]
      );
    }

    await logPropagation(client, {
      groupId,
      bizId,
      triggeredBy: articleId,
      propagatedTo,
      changeType: 'objetivo',
      changeDetail: { objetivo },
    });

    await client.query('COMMIT');

    console.log(`✅ [propagateObjetivo] objetivo=${objetivo}% → ${propagatedTo.length} artículos desde artículo ${articleId}`);
    return { propagatedTo, count: propagatedTo.length };

  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('[propagateObjetivo] Error:', e.message);
    return null;
  } finally {
    client.release();
  }
}

module.exports = { propagateRecipe, propagatePrecioManual, propagateObjetivo };