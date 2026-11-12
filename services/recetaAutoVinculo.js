// services/recetaAutoVinculo.js
// Vinculación automática de recetas idénticas (Diego 12/11/2026).
// Dos artículos del mismo negocio cuya receta tiene exactamente los mismos ingredientes
// (insumo/artículo, cantidad, unidad y merma) y el mismo rendimiento quedan vinculados
// por RECETA (link_type 'receta'), igual que si se hubiera hecho a mano desde el modal,
// con la marca `auto` para mostrar el chip. Solo vinculación de receta: la de precio
// (la de la tabla) no se toca.
'use strict';

const pool = require('../config/db');

// Firma de cada receta de artículo activa del negocio. ~6 ms con 600 recetas (Bar, 12/11).
const SQL_IDENTICAS = `
  WITH firmas AS (
    SELECT r.article_id, r.auto_vinculo_off,
      concat_ws('#', r.porciones::text, r.rendimiento_unidad::text, r.rendimiento_peso::text, r.unidad_peso::text,
        string_agg(concat_ws(':', COALESCE(ri.insumo_id, 0), COALESCE(ri.article_ref_id, 0),
                             round(ri.cantidad::numeric, 4), COALESCE(ri.unidad, ''),
                             COALESCE(ri.merma_id, 0), COALESCE(array_to_string(ri.merma_ids, ','), '')),
          '|' ORDER BY COALESCE(ri.insumo_id, 0), COALESCE(ri.article_ref_id, 0), ri.cantidad, COALESCE(ri.unidad, ''))) AS firma
      FROM recetas r
      JOIN receta_items ri ON ri.receta_id = r.id
     WHERE r.business_id = $1 AND r.active AND r.article_id IS NOT NULL AND r.insumo_id IS NULL
     GROUP BY r.id
  )
  SELECT f.article_id::bigint AS article_id
    FROM firmas f
   WHERE f.firma = (SELECT firma FROM firmas WHERE article_id = $2 AND NOT auto_vinculo_off LIMIT 1)
     AND f.article_id <> $2
     AND NOT f.auto_vinculo_off`;

async function grupoRecetaDe(client, bizId, ids) {
  const { rows } = await client.query(
    `SELECT article_id::bigint AS article_id, link_group_id::bigint AS group_id
       FROM article_link_members
      WHERE business_id = $1 AND link_type = 'receta' AND article_id = ANY($2::bigint[])`,
    [bizId, ids]);
  const m = new Map();
  for (const r of rows) m.set(Number(r.article_id), Number(r.group_id));
  return m;
}

/**
 * Vincula solo el artículo con los que tienen su misma receta.
 * - Si él ya está en un grupo de receta: suma a los idénticos que no estén en ninguno.
 * - Si no está: se suma al grupo de algún idéntico, o crea uno nuevo con todos los sueltos.
 * Un idéntico que ya está en OTRO grupo de receta no se mueve.
 * Devuelve { groupId, agregados: [ids] } o null si no hubo nada que hacer.
 */
async function autoVincularReceta(bizId, articleId) {
  bizId = Number(bizId); articleId = Number(articleId);
  if (!Number.isFinite(bizId) || !Number.isFinite(articleId)) return null;

  const { rows: iguales } = await pool.query(SQL_IDENTICAS, [bizId, articleId]);
  if (!iguales.length) return null;
  const ids = iguales.map((r) => Number(r.article_id));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const grupos = await grupoRecetaDe(client, bizId, [articleId, ...ids]);
    let groupId = grupos.get(articleId) || null;
    const agregados = [];

    if (!groupId) {
      // Sumarse al grupo de algún idéntico (el primero que tenga), o crear uno nuevo.
      groupId = ids.map((id) => grupos.get(id)).find(Boolean) || null;
      if (!groupId) {
        const { rows } = await client.query(
          `INSERT INTO article_link_groups (business_id, name, sync_recipe, sync_objetivo, sync_precio, link_type)
           VALUES ($1, NULL, TRUE, FALSE, FALSE, 'receta') RETURNING id`, [bizId]);
        groupId = Number(rows[0].id);
      }
      await client.query(
        `INSERT INTO article_link_members (link_group_id, article_id, business_id, link_type, auto)
         VALUES ($1, $2, $3, 'receta', TRUE) ON CONFLICT DO NOTHING`, [groupId, articleId, bizId]);
      agregados.push(articleId);
    }

    for (const id of ids) {
      if (grupos.has(id)) continue; // ya vinculado (a este grupo o a otro): no se mueve
      await client.query(
        `INSERT INTO article_link_members (link_group_id, article_id, business_id, link_type, auto)
         VALUES ($1, $2, $3, 'receta', TRUE) ON CONFLICT DO NOTHING`, [groupId, id, bizId]);
      agregados.push(id);
    }

    // Un grupo nuevo con un solo miembro (todos los idénticos estaban en otros grupos) no sirve.
    const { rows: cnt } = await client.query(
      `SELECT COUNT(*)::int AS n FROM article_link_members WHERE link_group_id = $1`, [groupId]);
    if ((cnt[0]?.n ?? 0) < 2) {
      await client.query('ROLLBACK');
      return null;
    }

    await client.query('COMMIT');
    return agregados.length ? { groupId, agregados } : null;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* nada */ }
    console.error('[autoVincularReceta]', e.message);
    return null;
  } finally {
    client.release();
  }
}

module.exports = { autoVincularReceta, SQL_IDENTICAS };
