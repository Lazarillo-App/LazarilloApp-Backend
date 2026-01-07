// services/autoGroupAssignment.js
const pool = require('../config/db');

/**
 * Asigna automáticamente artículos nuevos a agrupaciones existentes
 * basándose en coincidencias de categoria/subrubro (rubro/subrubro en Maxi)
 * 
 * Lógica:
 * 1. Busca artículos que NO estén en ninguna agrupación
 * 2. Para cada artículo, busca agrupaciones que tengan otros artículos
 *    con el MISMO categoria+subrubro
 * 3. Lo asigna automáticamente a esa agrupación
 * 
 * @param {number} businessId - ID del negocio
 * @returns {Promise<{assigned: number, details: Array}>}
 */
async function autoAssignNewArticles(businessId) {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    // 1️⃣ Obtener todos los artículos del negocio con su taxonomía
    const { rows: allArticles } = await client.query(`
      SELECT 
        ma.articulo_id,
        COALESCE(NULLIF(TRIM(ma.categoria), ''), '[PENDIENTE]') AS categoria,
        COALESCE(NULLIF(TRIM(ma.subrubro), ''), '[PENDIENTE]') AS subrubro
      FROM maxi_articles ma
      WHERE ma.business_id = $1
    `, [businessId]);

    if (!allArticles.length) {
      await client.query('COMMIT');
      return { assigned: 0, details: [] };
    }

    // 2️⃣ Obtener artículos que YA están en agrupaciones (con su taxonomía)
    const { rows: assignedArticles } = await client.query(`
      SELECT DISTINCT
        jsonb_array_elements(ag.articulos)::jsonb->>'id' AS articulo_id_str,
        COALESCE(NULLIF(TRIM(ma.categoria), ''), '[PENDIENTE]') AS categoria,
        COALESCE(NULLIF(TRIM(ma.subrubro), ''), '[PENDIENTE]') AS subrubro,
        ag.id AS agrupacion_id,
        ag.nombre AS agrupacion_nombre
      FROM agrupaciones ag
      CROSS JOIN LATERAL jsonb_array_elements(ag.articulos) AS art
      LEFT JOIN maxi_articles ma 
        ON ma.business_id = ag.business_id 
        AND ma.articulo_id = (art::jsonb->>'id')::int
      WHERE ag.business_id = $1
        AND ag.scope = 'articulo'
        AND LOWER(ag.nombre) NOT IN ('todo', 'sin agrupacion', 'sin agrupación', 'discontinuados')
    `, [businessId]);

    // 3️⃣ Crear mapas de asignación
    const assignedIds = new Set(
      assignedArticles.map(r => Number(r.articulo_id_str))
    );

    // Mapa: "categoria|subrubro" -> agrupacion_id
    const taxonomyToGroup = new Map();
    for (const row of assignedArticles) {
      const key = `${row.categoria}|${row.subrubro}`;
      if (!taxonomyToGroup.has(key)) {
        taxonomyToGroup.set(key, {
          id: row.agrupacion_id,
          nombre: row.agrupacion_nombre
        });
      }
    }

    // 4️⃣ Encontrar artículos sin asignar
    const unassigned = allArticles.filter(a => {
      const id = Number(a.articulo_id);
      return !assignedIds.has(id);
    });

    if (!unassigned.length) {
      await client.query('COMMIT');
      return { assigned: 0, details: [] };
    }

    // 5️⃣ Agrupar artículos sin asignar por su posible agrupación
    const toAssign = new Map(); // agrupacion_id -> [articulo_ids]

    for (const art of unassigned) {
      const key = `${art.categoria}|${art.subrubro}`;
      const targetGroup = taxonomyToGroup.get(key);

      if (targetGroup) {
        if (!toAssign.has(targetGroup.id)) {
          toAssign.set(targetGroup.id, {
            nombre: targetGroup.nombre,
            ids: []
          });
        }
        toAssign.get(targetGroup.id).ids.push(Number(art.articulo_id));
      }
    }

    // 6️⃣ Aplicar las asignaciones
    const details = [];
    let totalAssigned = 0;

    for (const [groupId, data] of toAssign.entries()) {
      const { nombre, ids } = data;
      
      if (!ids.length) continue;

      // Agregar los nuevos IDs al array existente de artículos
      await client.query(`
        UPDATE agrupaciones
        SET 
          articulos = articulos || $2::jsonb,
          updated_at = NOW()
        WHERE id = $1
      `, [
        groupId,
        JSON.stringify(ids.map(id => ({ id })))
      ]);

      totalAssigned += ids.length;
      details.push({
        agrupacion_id: groupId,
        agrupacion_nombre: nombre,
        articulos_agregados: ids.length,
        articulos: ids
      });

      console.log(`[auto-assign] ${ids.length} artículos → "${nombre}" (grupo ${groupId})`);
    }

    await client.query('COMMIT');

    return {
      assigned: totalAssigned,
      details
    };

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[autoAssignNewArticles] error:', error);
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  autoAssignNewArticles
};