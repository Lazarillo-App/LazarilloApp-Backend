/**
 * Repositorio de divisiones - Acceso a datos
 * Maneja todas las queries SQL para business_divisions
 */

const pool = require('../config/db');

/**
 * Obtener todas las divisiones de un negocio
 * @param {number} businessId - ID del negocio
 * @param {boolean} includeInactive - Incluir divisiones inactivas
 * @returns {Promise<Array>}
 */
async function getDivisions(businessId, includeInactive = false) {
  const query = `
    SELECT 
      id,
      business_id,
      name,
      code,
      description,
      is_main,
      is_active,
      display_order,
      config,
      source_group_id,
      created_at,
      updated_at
    FROM business_divisions
    WHERE business_id = $1
      ${!includeInactive ? 'AND is_active = true' : ''}
    ORDER BY 
      is_main DESC,
      display_order ASC,
      name ASC
  `;
  
  const result = await pool.query(query, [businessId]);
  return result.rows;
}

/**
 * Obtener divisiones con estadísticas
 * @param {number} businessId - ID del negocio
 * @param {boolean} includeInactive - Incluir divisiones inactivas
 * @returns {Promise<Array>}
 */
async function getDivisionsWithStats(businessId, includeInactive = false) {
  const query = `
    SELECT 
      bd.id,
      bd.business_id,
      bd.name,
      bd.code,
      bd.description,
      bd.is_main,
      bd.is_active,
      bd.display_order,
      bd.config,
      bd.source_group_id,
      bd.created_at,
      bd.updated_at,
      COUNT(DISTINCT a.id) as article_count,
      COUNT(DISTINCT CASE 
        WHEN sdi.day >= CURRENT_DATE - INTERVAL '30 days' 
        THEN sdi.business_id || '-' || sdi.article_id || '-' || sdi.day 
      END) as sales_last_30d
    FROM business_divisions bd
    LEFT JOIN app_articles a ON a.division_id = bd.id
    LEFT JOIN sales_daily_items sdi ON sdi.division_id = bd.id
    WHERE bd.business_id = $1
      ${!includeInactive ? 'AND bd.is_active = true' : ''}
    GROUP BY bd.id
    ORDER BY 
      bd.is_main DESC,
      bd.display_order ASC,
      bd.name ASC
  `;
  
  const result = await pool.query(query, [businessId]);
  return result.rows;
}

/**
 * Obtener una división por ID
 * @param {number} divisionId - ID de la división
 * @returns {Promise<Object|null>}
 */
async function getDivisionById(divisionId) {
  const query = `
    SELECT 
      id,
      business_id,
      name,
      code,
      description,
      is_main,
      is_active,
      display_order,
      config,
      source_group_id,
      created_at,
      updated_at
    FROM business_divisions
    WHERE id = $1
  `;
  
  const result = await pool.query(query, [divisionId]);
  return result.rows[0] || null;
}

/**
 * Obtener la división principal de un negocio
 * @param {number} businessId - ID del negocio
 * @returns {Promise<Object|null>}
 */
async function getMainDivision(businessId) {
  const query = `
    SELECT 
      id,
      business_id,
      name,
      code,
      description,
      is_main,
      is_active,
      display_order,
      config,
      source_group_id,
      created_at,
      updated_at
    FROM business_divisions
    WHERE business_id = $1 AND is_main = true
    LIMIT 1
  `;
  
  const result = await pool.query(query, [businessId]);
  return result.rows[0] || null;
}

/**
 * Verificar si existe una división con ese código
 * @param {number} businessId - ID del negocio
 * @param {string} code - Código a verificar
 * @param {number} excludeId - ID a excluir (para updates)
 * @returns {Promise<boolean>}
 */
async function existsByCode(businessId, code, excludeId = null) {
  const query = `
    SELECT id FROM business_divisions
    WHERE business_id = $1 AND code = $2
      ${excludeId ? 'AND id != $3' : ''}
  `;
  
  const params = excludeId ? [businessId, code, excludeId] : [businessId, code];
  const result = await pool.query(query, params);
  return result.rows.length > 0;
}

/**
 * Verificar si existe una división con ese nombre
 * @param {number} businessId - ID del negocio
 * @param {string} name - Nombre a verificar
 * @param {number} excludeId - ID a excluir (para updates)
 * @returns {Promise<boolean>}
 */
async function existsByName(businessId, name, excludeId = null) {
  const query = `
    SELECT id FROM business_divisions
    WHERE business_id = $1 AND name = $2
      ${excludeId ? 'AND id != $3' : ''}
  `;
  
  const params = excludeId ? [businessId, name, excludeId] : [businessId, name];
  const result = await pool.query(query, params);
  return result.rows.length > 0;
}

/**
 * Crear una nueva división
 * @param {Object} divisionData - Datos de la división
 * @returns {Promise<Object>}
 */
async function createDivision(divisionData) {
  const {
    business_id,
    name,
    code,
    description = null,
    is_active = true,
    display_order = 0,
    config = {},
    source_group_id = null,
  } = divisionData;
  
  const query = `
    INSERT INTO business_divisions (
      business_id,
      name,
      code,
      description,
      is_active,
      display_order,
      config,
      source_group_id
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING *
  `;
  
  const result = await pool.query(query, [
    business_id,
    name,
    code,
    description,
    is_active,
    display_order,
    JSON.stringify(config),
    source_group_id,
  ]);
  
  return result.rows[0];
}

/**
 * Actualizar una división
 * @param {number} divisionId - ID de la división
 * @param {Object} updates - Campos a actualizar
 * @returns {Promise<Object>}
 */
async function updateDivision(divisionId, updates) {
  const allowedFields = ['name', 'code', 'description', 'is_active', 'display_order', 'config'];
  const fields = [];
  const values = [];
  let paramCount = 1;
  
  for (const [key, value] of Object.entries(updates)) {
    if (allowedFields.includes(key)) {
      fields.push(`${key} = $${paramCount}`);
      values.push(key === 'config' ? JSON.stringify(value) : value);
      paramCount++;
    }
  }
  
  if (fields.length === 0) {
    throw new Error('No hay campos válidos para actualizar');
  }
  
  // Agregar updated_at
  fields.push(`updated_at = NOW()`);
  
  const query = `
    UPDATE business_divisions
    SET ${fields.join(', ')}
    WHERE id = $${paramCount}
    RETURNING *
  `;
  
  values.push(divisionId);
  
  const result = await pool.query(query, values);
  return result.rows[0];
}

/**
 * Eliminar una división (no se usa, mejor usar deleteDivision del service)
 * @param {number} divisionId - ID de la división
 * @returns {Promise<void>}
 */
async function hardDeleteDivision(divisionId) {
  const query = 'DELETE FROM business_divisions WHERE id = $1';
  await pool.query(query, [divisionId]);
}

/**
 * Contar artículos en una división
 * @param {number} divisionId - ID de la división
 * @returns {Promise<number>}
 */
async function countArticles(divisionId) {
  const query = 'SELECT COUNT(*) as count FROM app_articles WHERE division_id = $1';
  const result = await pool.query(query, [divisionId]);
  return parseInt(result.rows[0].count, 10);
}

/**
 * Mover artículos de una división a otra
 * @param {number} fromDivisionId - División origen
 * @param {number} toDivisionId - División destino
 * @returns {Promise<number>} - Cantidad de artículos movidos
 */
async function moveArticles(fromDivisionId, toDivisionId) {
  const query = `
    UPDATE app_articles
    SET division_id = $2
    WHERE division_id = $1
  `;
  
  const result = await pool.query(query, [fromDivisionId, toDivisionId]);
  return result.rowCount;
}

/**
 * Mover ventas de una división a otra
 * @param {number} fromDivisionId - División origen
 * @param {number} toDivisionId - División destino
 * @returns {Promise<number>} - Cantidad de ventas movidas
 */
async function moveSales(fromDivisionId, toDivisionId) {
  const query = `
    UPDATE sales_daily_items
    SET division_id = $2
    WHERE division_id = $1
  `;
  
  const result = await pool.query(query, [fromDivisionId, toDivisionId]);
  return result.rowCount;
}

/**
 * Reordenar divisiones
 * @param {Array<{id: number, display_order: number}>} orders
 * @returns {Promise<void>}
 */
async function updateDisplayOrders(orders) {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    for (const { id, display_order } of orders) {
      await client.query(
        'UPDATE business_divisions SET display_order = $1 WHERE id = $2',
        [display_order, id]
      );
    }
    
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  getDivisions,
  getDivisionsWithStats,
  getDivisionById,
  getMainDivision,
  existsByCode,
  existsByName,
  createDivision,
  updateDivision,
  hardDeleteDivision,
  countArticles,
  moveArticles,
  moveSales,
  updateDisplayOrders,
};