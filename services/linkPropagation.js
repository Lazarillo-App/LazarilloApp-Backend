// services/linkPropagation.js
'use strict';

const pool = require('../config/db');

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
  return rows;
}

async function logPropagation(client, { groupId, bizId, triggeredBy, propagatedTo, changeType, changeDetail }) {
  try {
    await client.query(
      `INSERT INTO article_link_propagations
         (link_group_id, business_id, triggered_by, propagated_to, change_type, change_detail)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [groupId, bizId, triggeredBy, propagatedTo, changeType, JSON.stringify(changeDetail || {})]
    );
  } catch (e) {
    console.warn('[linkPropagation] Error al loguear propagacion:', e.message);
  }
}

async function propagateRecipe({ bizId, articleId, receta, savedItems }) {
  const siblings = await getLinkSiblings(bizId, articleId);
  if (!siblings) return;

  // ← CORREGIDO: usar los siblings reales, filtrando solo sync_recipe === false
  const targets = siblings.filter(s => s.sync_recipe !== false);
  if (!targets.length) return;

  const groupId = targets[0].group_id;
  const groupName = targets[0].group_name;
  const propagatedTo = targets.map(s => Number(s.article_id));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const sibling of targets) {
      const siblingId = Number(sibling.article_id);

      // Upsert receta del sibling
      // IMPORTANTE: porcentaje_venta NO se propaga en el UPDATE
      // (cada gemelo mantiene su propio objetivo de costo)
      const { rows: recetaRows } =
        await client.query(
          `INSERT INTO recetas
     (article_id, business_id, nombre, descripcion, porciones,
      porcentaje_venta, costo_total, notas, foto, notas_updated_at,
      active, origen, updated_at)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE, 'linked', NOW())
   ON CONFLICT (article_id, business_id)
   DO UPDATE SET
     porciones        = EXCLUDED.porciones,
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
            receta.porcentaje_venta || 0,  // solo para INSERT nuevo, ignorado en UPDATE
            receta.costo_total,
            receta.notas || null,
            receta.foto || null,
            receta.notas_updated_at || null,
          ]
        );

      const siblingRecetaId = recetaRows[0].id;

      await client.query(`DELETE FROM receta_items WHERE receta_id = $1`, [siblingRecetaId]);

      for (const item of savedItems || []) {
        const insumoId = Number(item.insumo_id ?? item.supply_id);
        if (!Number.isFinite(insumoId) || insumoId <= 0) continue;

        const fotosUrls = Array.isArray(item.fotos_urls)
          ? item.fotos_urls.filter(u => typeof u === 'string' && u.startsWith('http'))
          : [];

        await client.query(
          `INSERT INTO receta_items
             (receta_id, insumo_id, cantidad, unidad, costo_unitario, notas,
              observaciones, fotos_urls, merma, pedido, tipo_costo, orden,
              created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), NOW())`,
          [
            siblingRecetaId,
            insumoId,
            item.cantidad,
            item.unidad || null,
            item.costo_unitario,
            item.notas || null,
            item.observaciones || null,
            fotosUrls,
            item.merma !== false,
            item.pedido !== false,
            item.tipo_costo || 'total',
            item.orden ?? 0,
          ]
        );
      }

      console.log(`[propagateRecipe] Receta copiada -> articulo ${siblingId} (grupo "${groupName}")`);
    }

    await logPropagation(client, {
      groupId, bizId,
      triggeredBy: articleId,
      propagatedTo,
      changeType: 'recipe',
      changeDetail: { costo_total: receta.costo_total, items_count: (savedItems || []).length },
    });

    await client.query('COMMIT');

    console.log(`[propagateRecipe] ${propagatedTo.length} articulos actualizados desde articulo ${articleId}`);
    return { propagatedTo, count: propagatedTo.length };

  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { }
    console.error('[propagateRecipe] Error:', e.message);
    return null;
  } finally {
    client.release();
  }
}

async function propagatePrecioManual({ bizId, articleId, precioManual }) {
  const siblings = await getLinkSiblings(bizId, articleId);
  if (!siblings) return;

  const targets = siblings.filter(s => s.sync_precio !== false);
  if (!targets.length) return;

  const groupId = targets[0].group_id;
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
      groupId, bizId,
      triggeredBy: articleId,
      propagatedTo,
      changeType: 'precio_manual',
      changeDetail: { precioManual },
    });

    await client.query('COMMIT');
    return { propagatedTo, count: propagatedTo.length };

  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { }
    console.error('[propagatePrecioManual] Error:', e.message);
    return null;
  } finally {
    client.release();
  }
}

async function propagateObjetivo({ bizId, articleId, objetivo }) {
  const siblings = await getLinkSiblings(bizId, articleId);
  if (!siblings) return;

  const targets = siblings.filter(s => s.sync_objetivo !== false);
  if (!targets.length) return;

  const groupId = targets[0].group_id;
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
      groupId, bizId,
      triggeredBy: articleId,
      propagatedTo,
      changeType: 'objetivo',
      changeDetail: { objetivo },
    });

    await client.query('COMMIT');
    return { propagatedTo, count: propagatedTo.length };

  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { }
    console.error('[propagateObjetivo] Error:', e.message);
    return null;
  } finally {
    client.release();
  }
}

module.exports = { propagateRecipe, propagatePrecioManual, propagateObjetivo, getLinkSiblings };