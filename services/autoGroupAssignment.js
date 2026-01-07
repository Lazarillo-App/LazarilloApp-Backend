// services/autoGroupAssignment.js
const pool = require('../config/db'); // 🆕 FALTABA ESTO

/**
 * Asigna automáticamente artículos nuevos a agrupaciones existentes
 * basándose en coincidencias de categoria/subrubro (rubro/subrubro en Maxi)
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

    // 2️⃣ Artículos ya asignados
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

    console.log('✅ [auto-assign] Artículos ya asignados:', assignedArticles.length);

    // 3️⃣ Crear mapa de taxonomía
    const assignedIds = new Set(
      assignedArticles.map(r => Number(r.articulo_id_str))
    );

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

    console.log('🗺️  [auto-assign] Mapa taxonomía -> grupo:', 
      Array.from(taxonomyToGroup.entries()).map(([k, v]) => `"${k}" -> "${v.nombre}"`)
    );

    // 4️⃣ Artículos sin asignar
    const unassigned = allArticles.filter(a => {
      const id = Number(a.articulo_id);
      return !assignedIds.has(id);
    });

    console.log('❓ [auto-assign] Sin asignar:', unassigned.length);
    
    if (unassigned.length > 0) {
      console.log('📋 [auto-assign] Primeros 5 sin asignar:', 
        unassigned.slice(0, 5).map(a => ({
          id: a.articulo_id,
          key: `${a.categoria}|${a.subrubro}`,
          hasMatch: taxonomyToGroup.has(`${a.categoria}|${a.subrubro}`)
        }))
      );
    }

    if (!unassigned.length) {
      await client.query('COMMIT');
      return { assigned: 0, details: [] };
    }

    // 5️⃣ Agrupar por destino
    const toAssign = new Map();

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

    console.log('🎯 [auto-assign] A asignar:', 
      Array.from(toAssign.entries()).map(([gid, data]) => 
        `${data.ids.length} artículos -> "${data.nombre}" (${gid})`
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

    console.log('🏁 [auto-assign] RESULTADO FINAL:', { totalAssigned, details });

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