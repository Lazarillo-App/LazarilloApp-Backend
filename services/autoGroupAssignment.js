// services/autoGroupAssignment.js
const pool = require('../config/db');

/**
 * Asigna automáticamente artículos nuevos a agrupaciones existentes
 * basándose en coincidencias de categoria/subrubro
 */
async function autoAssignNewArticles(businessId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Artículos existentes en maxi_articles del negocio
    const { rows: allArticles } = await client.query(
      `SELECT ma.articulo_id
         FROM maxi_articles ma
        WHERE ma.business_id = $1`,
      [businessId]
    );

    if (!allArticles.length) {
      await client.query('COMMIT');
      return { assigned: 0, details: [] };
    }

    // IDs ya asignados en cualquier agrupación real de la org
    // (excluye Sin Agrupación y Discontinuados)
    const { rows: assignedRows } = await client.query(
      `WITH article_ids AS (
          SELECT (elem->>'id')::int AS articulo_id
          FROM agrupaciones ag,
          LATERAL jsonb_array_elements(ag.articulos) AS elem
          WHERE ag.business_id = $1
            AND LOWER(ag.nombre) NOT IN ('todo', 'sin agrupacion', 'sin agrupación', 'discontinuados', 'descontinuados')
            AND ag.moved_to_business_id IS NULL
        )
        SELECT DISTINCT articulo_id FROM article_ids WHERE articulo_id IS NOT NULL`,
      [businessId]
    );

    const assignedIds = new Set(
      assignedRows.map(r => Number(r.articulo_id)).filter(n => Number.isFinite(n) && n > 0)
    );

    // Artículos sin asignar → van todos a Sin Agrupación (pool global)
    const unassigned = allArticles
      .map(a => Number(a.articulo_id))
      .filter(id => Number.isFinite(id) && id > 0 && !assignedIds.has(id));

    console.log(`[auto-assign] ${allArticles.length} artículos, ${assignedIds.size} asignados, ${unassigned.length} sin asignar`);

    if (!unassigned.length) {
      await client.query('COMMIT');
      return { assigned: 0, details: [] };
    }

    // Buscar Sin Agrupación del negocio (siempre el principal llama a esta función)
    const { rows: todoRows } = await client.query(
      `SELECT id FROM agrupaciones
          WHERE business_id = $1
            AND (nombre ILIKE 'Sin Agrupac%' OR nombre ILIKE 'Sin Agrupar%')
          LIMIT 1`,
      [businessId]
    );

    if (!todoRows[0]?.id) {
      console.warn(`[auto-assign] No se encontró Sin Agrupación para negocio ${businessId}`);
      await client.query('COMMIT');
      return { assigned: 0, details: [] };
    }

    // Agregar solo los que no estén ya en Sin Agrupación (evitar duplicados)
    const { rows: alreadyInTodo } = await client.query(
      `SELECT (elem->>'id')::int AS articulo_id
          FROM agrupaciones,
          LATERAL jsonb_array_elements(articulos) AS elem
         WHERE id = $1`,
      [todoRows[0].id]
    );
    const alreadyTodoIds = new Set(
      alreadyInTodo.map(r => Number(r.articulo_id)).filter(n => n > 0)
    );

    const toAdd = unassigned.filter(id => !alreadyTodoIds.has(id));

    if (toAdd.length > 0) {
      await client.query(
        `UPDATE agrupaciones
            SET articulos = articulos || $2::jsonb, updated_at = NOW()
          WHERE id = $1`,
        [todoRows[0].id, JSON.stringify(toAdd.map(id => ({ id })))]
      );
      console.log(`[auto-assign] ${toAdd.length} artículos nuevos → Sin Agrupación global (negocio ${businessId})`);
    }

    await client.query('COMMIT');

    return {
      assigned: toAdd.length,
      details: toAdd.length ? [{ agrupacion_id: todoRows[0].id, agrupacion_nombre: 'Sin Agrupación', articulos_agregados: toAdd.length, articulos: toAdd.map(id => ({ id })) }] : []
    };

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[auto-assign] ERROR:', error);
    throw error;
  } finally {
    client.release();
  }
}


module.exports = {
  autoAssignNewArticles
};