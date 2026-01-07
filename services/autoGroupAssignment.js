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

    // 1️⃣ Artículos del negocio
    const { rows: allArticles } = await client.query(`
      SELECT 
        ma.articulo_id,
        COALESCE(NULLIF(TRIM(ma.categoria), ''), '[PENDIENTE]') AS categoria,
        COALESCE(NULLIF(TRIM(ma.subrubro), ''), '[PENDIENTE]') AS subrubro
      FROM maxi_articles ma
      WHERE ma.business_id = $1
    `, [businessId]);

    console.log('📦 [auto-assign] Total artículos en maxi_articles:', allArticles.length);

    // 2️⃣ Artículos ya asignados - CORREGIDO: usar WITH + LATERAL
    const { rows: assignedArticles } = await client.query(`
      WITH article_ids AS (
        SELECT 
          ag.id AS agrupacion_id,
          ag.nombre AS agrupacion_nombre,
          (elem->>'id')::int AS articulo_id
        FROM agrupaciones ag,
        LATERAL jsonb_array_elements(ag.articulos) AS elem
        WHERE ag.business_id = $1
          AND LOWER(ag.nombre) NOT IN ('todo', 'sin agrupacion', 'sin agrupación', 'discontinuados')
      )
      SELECT DISTINCT
        ai.articulo_id,
        COALESCE(NULLIF(TRIM(ma.categoria), ''), '[PENDIENTE]') AS categoria,
        COALESCE(NULLIF(TRIM(ma.subrubro), ''), '[PENDIENTE]') AS subrubro,
        ai.agrupacion_id,
        ai.agrupacion_nombre
      FROM article_ids ai
      LEFT JOIN maxi_articles ma 
        ON ma.business_id = $1 
        AND ma.articulo_id = ai.articulo_id
    `, [businessId]);

    console.log('✅ [auto-assign] Artículos ya asignados:', assignedArticles.length);

    // 3️⃣ Crear mapa de taxonomía
    const assignedIds = new Set(
      assignedArticles
        .map(r => Number(r.articulo_id))
        .filter(n => Number.isFinite(n) && n > 0)
    );

    // Mapa: "categoria|subrubro" → [ { id, nombre }, ... ]
    const taxonomyToGroups = new Map();
    
    for (const row of assignedArticles) {
      if (!row.categoria || !row.subrubro) continue;
      
      const key = `${row.categoria}|${row.subrubro}`;
      
      if (!taxonomyToGroups.has(key)) {
        taxonomyToGroups.set(key, []);
      }
      
      const groups = taxonomyToGroups.get(key);
      
      // Agregar grupo solo si no está ya en la lista
      if (!groups.find(g => g.id === row.agrupacion_id)) {
        groups.push({
          id: row.agrupacion_id,
          nombre: row.agrupacion_nombre
        });
      }
    }

    console.log('🗺️  [auto-assign] Taxonomías encontradas:', taxonomyToGroups.size);
    console.log('🗺️  [auto-assign] Primeras 10 taxonomías:', 
      Array.from(taxonomyToGroups.entries())
        .slice(0, 10)
        .map(([k, groups]) => `"${k}" → [${groups.map(g => `"${g.nombre}"`).join(', ')}]`)
    );

    // 4️⃣ Artículos sin asignar
    const unassigned = allArticles.filter(a => {
      const id = Number(a.articulo_id);
      return Number.isFinite(id) && id > 0 && !assignedIds.has(id);
    });

    console.log('❓ [auto-assign] Artículos sin asignar:', unassigned.length);
    
    if (unassigned.length > 0) {
      console.log('📋 [auto-assign] Primeros 10 sin asignar:', 
        unassigned.slice(0, 10).map(a => {
          const key = `${a.categoria}|${a.subrubro}`;
          const matchingGroups = taxonomyToGroups.get(key) || [];
          return {
            id: a.articulo_id,
            key,
            hasMatch: matchingGroups.length > 0,
            targetGroups: matchingGroups.map(g => g.nombre)
          };
        })
      );
    }

    if (!unassigned.length) {
      await client.query('COMMIT');
      return { assigned: 0, details: [] };
    }

    // 5️⃣ Agrupar por destino (elegimos el PRIMER grupo que matchea)
    const toAssign = new Map();

    for (const art of unassigned) {
      const key = `${art.categoria}|${art.subrubro}`;
      const matchingGroups = taxonomyToGroups.get(key);

      if (matchingGroups && matchingGroups.length > 0) {
        // Tomar el primer grupo que matchea
        const targetGroup = matchingGroups[0];
        
        if (!toAssign.has(targetGroup.id)) {
          toAssign.set(targetGroup.id, {
            nombre: targetGroup.nombre,
            ids: []
          });
        }
        
        toAssign.get(targetGroup.id).ids.push(Number(art.articulo_id));
      }
    }

    console.log('🎯 [auto-assign] Grupos a actualizar:', toAssign.size);
    console.log('🎯 [auto-assign] Detalle:', 
      Array.from(toAssign.entries()).map(([gid, data]) => 
        `${data.ids.length} artículos → "${data.nombre}" (grupo ${gid})`
      )
    );

    // 6️⃣ Aplicar asignaciones
    const details = [];
    let totalAssigned = 0;

    for (const [groupId, data] of toAssign.entries()) {
      const { nombre, ids } = data;
      
      if (!ids.length) continue;

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

      console.log(`✨ [auto-assign] ${ids.length} artículos → "${nombre}" (grupo ${groupId})`);
    }

    await client.query('COMMIT');

    console.log('🏁 [auto-assign] RESULTADO FINAL:', { 
      totalAssigned, 
      gruposActualizados: details.length,
      details: details.map(d => ({
        grupo: d.agrupacion_nombre,
        agregados: d.articulos_agregados
      }))
    });

    return {
      assigned: totalAssigned,
      details
    };

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ [auto-assign] ERROR:', error);
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  autoAssignNewArticles
};