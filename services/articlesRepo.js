// services/articlesRepo.js
const pool = require('../config/db');

/* ═══════════════════════════════════════════════════════════════════════════
   🆕 HELPER PARA SUBNEGOCIOS
   Detecta si un businessId es un subnegocio y retorna el contexto correcto
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Obtiene el contexto de negocio/subnegocio
 * @param {number} businessId - ID del negocio a verificar
 * @returns {Promise<{
 *   isSubnegocio: boolean,
 *   effectiveId: number,
 *   parentId: number|null,
 *   agrupacionIds: number[]
 * }>}
 */
async function getBusinessContext(businessId) {
  // Obtener información del negocio
  const { rows: bizRows } = await pool.query(`
    SELECT id, parent_id 
    FROM app_businesses 
    WHERE id = $1
  `, [businessId]);

  if (!bizRows.length) {
    throw Object.assign(new Error('business_not_found'), { status: 404 });
  }

  const biz = bizRows[0];
  const isSubnegocio = !!biz.parent_id;
  const effectiveId = isSubnegocio ? biz.parent_id : businessId;
  
  let agrupacionIds = [];
  
  // Si es subnegocio, obtener agrupaciones asignadas
  if (isSubnegocio) {
    const { rows: agrupRows } = await pool.query(`
      SELECT agrupacion_id 
      FROM business_agrupaciones 
      WHERE business_id = $1
    `, [businessId]);
    
    agrupacionIds = agrupRows.map(r => r.agrupacion_id);
  }

  return {
    isSubnegocio,
    effectiveId,      // ID del negocio principal (o el mismo si no es subnegocio)
    parentId: biz.parent_id,
    agrupacionIds,    // IDs de agrupaciones asignadas (solo si es subnegocio)
    originalId: businessId
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   🆕 FUNCIONES CON SOPORTE PARA SUBNEGOCIOS
   Si es subnegocio, filtra artículos por agrupaciones asignadas
   ═══════════════════════════════════════════════════════════════════════════ */

// Devuelve filas normalizadas (ya usando la taxonomía) con soporte para subnegocios
async function fetchArticlesFlat(businessId) {
  // 🆕 Obtener contexto de negocio/subnegocio
  const ctx = await getBusinessContext(businessId);
  
  // Construir filtro de agrupaciones si es subnegocio
  let agrupacionFilter = '';
  const params = [ctx.effectiveId];
  
  if (ctx.isSubnegocio && ctx.agrupacionIds.length > 0) {
    params.push(ctx.agrupacionIds);
    agrupacionFilter = `AND a.agrupacion_id = ANY($${params.length})`;
  }
  
  const sql = `
    SELECT
      s.nombre AS subrubro,
      c.nombre AS categoria,
      a.id, 
      a.name AS nombre,
      a.price AS precio,
      COALESCE(a.costo, 0) AS costo,
      a.agrupacion_id
    FROM app_articles a
    JOIN categorias c ON c.id = a.categoria_id
    JOIN subrubros s ON s.id = a.subrubro_id
    WHERE a.business_id = $1
    ${agrupacionFilter}
  `;
  
  const { rows } = await pool.query(sql, params);
  return rows;
}

// Agrupa a -> [{ subrubro, categorias: [{ categoria, articulos: [...] }] }]
function buildTree(rows) {
  const bySub = new Map();
  for (const r of rows) {
    if (!bySub.has(r.subrubro)) bySub.set(r.subrubro, new Map());
    const byCat = bySub.get(r.subrubro);
    if (!byCat.has(r.categoria)) byCat.set(r.categoria, []);
    byCat.get(r.categoria).push({
      id: Number(r.id),
      nombre: r.nombre,
      precio: Number(r.precio || 0),
      costo: Number(r.costo || 0),
      agrupacion_id: r.agrupacion_id || null,
    });
  }
  return Array.from(bySub, ([subrubro, byCat]) => ({
    subrubro,
    categorias: Array.from(byCat, ([categoria, articulos]) => ({ categoria, articulos })),
  }));
}

async function fetchArticlesTree(businessId) {
  const flat = await fetchArticlesFlat(businessId);
  return buildTree(flat);
}

/* ═══════════════════════════════════════════════════════════════════════════
   🆕 FUNCIÓN PARA OBTENER RESUMEN DE CONTEXTO
   Útil para debugging y respuestas informativas
   ═══════════════════════════════════════════════════════════════════════════ */

async function getArticlesContext(businessId) {
  const ctx = await getBusinessContext(businessId);
  
  // Contar artículos totales del negocio efectivo
  const { rows: totalRows } = await pool.query(`
    SELECT COUNT(*) as total 
    FROM app_articles 
    WHERE business_id = $1
  `, [ctx.effectiveId]);
  
  let filteredCount = totalRows[0]?.total || 0;
  
  // Si es subnegocio, contar artículos filtrados
  if (ctx.isSubnegocio && ctx.agrupacionIds.length > 0) {
    const { rows: filteredRows } = await pool.query(`
      SELECT COUNT(*) as total 
      FROM app_articles 
      WHERE business_id = $1 
        AND agrupacion_id = ANY($2)
    `, [ctx.effectiveId, ctx.agrupacionIds]);
    
    filteredCount = filteredRows[0]?.total || 0;
  }
  
  return {
    is_subnegocio: ctx.isSubnegocio,
    parent_id: ctx.parentId,
    effective_business_id: ctx.effectiveId,
    original_business_id: ctx.originalId,
    agrupaciones_asignadas: ctx.agrupacionIds,
    total_articulos_negocio: totalRows[0]?.total || 0,
    articulos_disponibles: filteredCount
  };
}

module.exports = { 
  fetchArticlesFlat, 
  fetchArticlesTree,
  getArticlesContext,
  getBusinessContext // Exportar para uso en otros servicios
};