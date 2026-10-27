// services/autoGroupAssignment.js
const pool = require('../config/db');

const norm = (s) => String(s || '').trim().toLowerCase();

/**
 * Regla persistente rubro→agrupación (articulo_group_rules): antes de mandar
 * los artículos sin asignar a "Sin Agrupación" (autoAssignNewArticles, más
 * abajo), si su rubro ("Rubro" en la UI = columna maxi_articles.subrubro)
 * tiene una regla guardada, van directo a esa agrupación. La regla se guarda
 * al mover un rubro completo desde Sin Agrupación (ver SubrubroAccionesMenu.jsx).
 *
 * IMPORTANTE: llamar ANTES de autoAssignNewArticles en el mismo sync — lo que
 * esta función ya asigna queda afuera del cálculo de "sin asignar" de esa
 * otra (porque ya están en una agrupación real), así que el orden alcanza
 * solo, sin coordinación extra entre las dos.
 */
async function applyArticuloGroupRules(businessId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: rules } = await client.query(
      `SELECT r.rubro, r.group_id
         FROM articulo_group_rules r
         JOIN agrupaciones g ON g.id = r.group_id
        WHERE r.business_id = $1
          AND g.business_id = $1
          AND g.moved_to_business_id IS NULL
          AND LOWER(g.nombre) NOT IN ('todo', 'sin agrupacion', 'sin agrupación', 'sin agrupar', 'sin grupo', 'discontinuados', 'descontinuados')`,
      [businessId]
    );
    if (!rules.length) { await client.query('COMMIT'); return { assigned: 0, details: [] }; }
    const ruleMap = new Map(rules.map((r) => [norm(r.rubro), Number(r.group_id)]));

    const { rows: allArticles } = await client.query(
      `SELECT ma.articulo_id, ma.subrubro AS rubro FROM maxi_articles ma WHERE ma.business_id = $1`,
      [businessId]
    );
    if (!allArticles.length) { await client.query('COMMIT'); return { assigned: 0, details: [] }; }

    // Mismo criterio que autoAssignNewArticles: ya asignado a cualquier
    // agrupación real = no se toca.
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
      assignedRows.map((r) => Number(r.articulo_id)).filter((n) => Number.isFinite(n) && n > 0)
    );

    const porGrupo = new Map(); // group_id -> [articulo_id]
    for (const a of allArticles) {
      const id = Number(a.articulo_id);
      if (!Number.isFinite(id) || id <= 0 || assignedIds.has(id)) continue;
      const gid = ruleMap.get(norm(a.rubro));
      if (!gid) continue;
      if (!porGrupo.has(gid)) porGrupo.set(gid, []);
      porGrupo.get(gid).push(id);
    }

    let total = 0;
    const details = [];
    for (const [gid, ids] of porGrupo) {
      const { rows: yaEn } = await client.query(
        `SELECT (elem->>'id')::int AS articulo_id
           FROM agrupaciones, LATERAL jsonb_array_elements(articulos) elem
          WHERE id = $1`,
        [gid]
      );
      const yaIds = new Set(yaEn.map((r) => Number(r.articulo_id)).filter((n) => n > 0));
      const nuevos = ids.filter((id) => !yaIds.has(id));
      if (!nuevos.length) continue;

      await client.query(
        `UPDATE agrupaciones SET articulos = articulos || $2::jsonb, updated_at = NOW() WHERE id = $1`,
        [gid, JSON.stringify(nuevos.map((id) => ({ id })))]
      );
      total += nuevos.length;
      details.push({ agrupacion_id: gid, articulos_agregados: nuevos.length });
    }

    console.log(`[articulo-group-rules] ${total} artículo(s) auto-asignados por regla de rubro (negocio ${businessId})`);
    await client.query('COMMIT');
    return { assigned: total, details };
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[articulo-group-rules] ERROR:', error);
    throw error;
  } finally {
    client.release();
  }
}

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
  autoAssignNewArticles,
  applyArticuloGroupRules,
};