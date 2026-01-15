/**
 * Servicio de divisiones - Lógica de negocio
 */

const divisionsRepo = require('../repos/divisionsRepo');
const pool = require('../config/db');

/**
 * Obtener todas las divisiones de un negocio
 */
async function getDivisions(businessId, options = {}) {
  const { includeInactive = false, includeStats = false } = options;
  
  if (includeStats) {
    return await divisionsRepo.getDivisionsWithStats(businessId, includeInactive);
  }
  
  return await divisionsRepo.getDivisions(businessId, includeInactive);
}

/**
 * Obtener una división por ID
 */
async function getDivisionById(divisionId) {
  const division = await divisionsRepo.getDivisionById(divisionId);
  
  if (!division) {
    const error = new Error('División no encontrada');
    error.status = 404;
    throw error;
  }
  
  return division;
}

/**
 * Obtener la división principal
 */
async function getMainDivision(businessId) {
  const division = await divisionsRepo.getMainDivision(businessId);
  
  if (!division) {
    const error = new Error('No existe división principal para este negocio');
    error.status = 404;
    throw error;
  }
  
  return division;
}

/**
 * Crear una nueva división
 */
async function createDivision(divisionData) {
  const { business_id, name, code } = divisionData;
  
  // Validar que código sea único
  const codeExists = await divisionsRepo.existsByCode(business_id, code);
  if (codeExists) {
    const error = new Error(`Ya existe una división con el código '${code}'`);
    error.status = 400;
    throw error;
  }
  
  // Validar que nombre sea único
  const nameExists = await divisionsRepo.existsByName(business_id, name);
  if (nameExists) {
    const error = new Error(`Ya existe una división con el nombre '${name}'`);
    error.status = 400;
    throw error;
  }
  
  // Crear la división
  return await divisionsRepo.createDivision(divisionData);
}

/**
 * Actualizar una división
 */
async function updateDivision(divisionId, updates) {
  // Verificar que existe
  const division = await divisionsRepo.getDivisionById(divisionId);
  if (!division) {
    const error = new Error('División no encontrada');
    error.status = 404;
    throw error;
  }
  
  // No permitir desactivar la división principal
  if (division.is_main && updates.is_active === false) {
    const error = new Error('No se puede desactivar la división principal');
    error.status = 400;
    throw error;
  }
  
  // Validar código único (si se está actualizando)
  if (updates.code && updates.code !== division.code) {
    const codeExists = await divisionsRepo.existsByCode(
      division.business_id, 
      updates.code, 
      divisionId
    );
    if (codeExists) {
      const error = new Error(`Ya existe una división con el código '${updates.code}'`);
      error.status = 400;
      throw error;
    }
  }
  
  // Validar nombre único (si se está actualizando)
  if (updates.name && updates.name !== division.name) {
    const nameExists = await divisionsRepo.existsByName(
      division.business_id, 
      updates.name, 
      divisionId
    );
    if (nameExists) {
      const error = new Error(`Ya existe una división con el nombre '${updates.name}'`);
      error.status = 400;
      throw error;
    }
  }
  
  // Actualizar
  return await divisionsRepo.updateDivision(divisionId, updates);
}

/**
 * Eliminar una división
 * Los artículos y ventas se mueven automáticamente a la división principal
 */
async function deleteDivision(divisionId) {
  // Verificar que existe
  const division = await divisionsRepo.getDivisionById(divisionId);
  if (!division) {
    const error = new Error('División no encontrada');
    error.status = 404;
    throw error;
  }
  
  // No permitir eliminar la división principal
  if (division.is_main) {
    const error = new Error('No se puede eliminar la división principal');
    error.status = 400;
    throw error;
  }
  
  // Obtener división principal para mover artículos
  const mainDivision = await divisionsRepo.getMainDivision(division.business_id);
  if (!mainDivision) {
    const error = new Error('No existe división principal para mover los artículos');
    error.status = 500;
    throw error;
  }
  
  // Mover artículos y ventas, luego eliminar
  const articlesMoved = await divisionsRepo.moveArticles(divisionId, mainDivision.id);
  const salesMoved = await divisionsRepo.moveSales(divisionId, mainDivision.id);
  
  await divisionsRepo.hardDeleteDivision(divisionId);
  
  return {
    message: 'División eliminada exitosamente',
    division_id: divisionId,
    articles_moved: articlesMoved,
    sales_moved: salesMoved,
    moved_to_division: mainDivision.name,
  };
}

/**
 * Convertir una agrupación existente en una división
 */
async function convertGroupToDivision(conversionData) {
  const {
    business_id,
    group_id,
    new_name,
    new_code,
    inherit_config = true,
    move_articles = true,
  } = conversionData;
  
  // 1. Verificar que la agrupación existe
  const groupQuery = `
    SELECT id, name, description, config, status, converted_to_division_id
    FROM business_groups
    WHERE id = $1 AND business_id = $2
  `;
  
  const groupResult = await pool.query(groupQuery, [group_id, business_id]);
  const group = groupResult.rows[0];
  
  if (!group) {
    const error = new Error('Agrupación no encontrada');
    error.status = 404;
    throw error;
  }
  
  // Verificar que no esté ya convertida
  if (group.status === 'converted') {
    const error = new Error(`La agrupación '${group.name}' ya fue convertida a división`);
    error.status = 400;
    throw error;
  }
  
  // 2. Crear la nueva división
  const divisionName = new_name || group.name;
  const divisionCode = new_code || generateCodeFromName(divisionName);
  
  const divisionConfig = inherit_config && group.config ? group.config : {};
  
  const divisionData = {
    business_id,
    name: divisionName,
    code: divisionCode,
    description: group.description,
    config: divisionConfig,
    source_group_id: group.id,
    is_active: true,
    display_order: 0,
  };
  
  const division = await createDivision(divisionData);
  
  // 3. Marcar la agrupación como convertida
  await pool.query(
    `UPDATE business_groups 
     SET status = 'converted', converted_to_division_id = $1 
     WHERE id = $2`,
    [division.id, group.id]
  );
  
  // 4. Mover artículos si se especifica
  let articlesMoved = 0;
  if (move_articles) {
    // Obtener artículos de la agrupación
    const articlesQuery = `
      SELECT DISTINCT article_id
      FROM article_groups
      WHERE group_id = $1 AND business_id = $2
    `;
    
    const articlesResult = await pool.query(articlesQuery, [group.id, business_id]);
    const articleIds = articlesResult.rows.map(r => r.article_id);
    
    if (articleIds.length > 0) {
      const updateQuery = `
        UPDATE app_articles
        SET division_id = $1
        WHERE id = ANY($2) AND business_id = $3
      `;
      
      const updateResult = await pool.query(updateQuery, [
        division.id,
        articleIds,
        business_id,
      ]);
      
      articlesMoved = updateResult.rowCount;
    }
  }
  
  return {
    division,
    articles_moved: articlesMoved,
    source_group_id: group.id,
    source_group_name: group.name,
  };
}

/**
 * Reordenar divisiones
 */
async function reorderDivisions(businessId, orderArray) {
  // Verificar que todas las divisiones pertenecen al negocio
  const divisions = await divisionsRepo.getDivisions(businessId);
  const divisionIds = divisions.map(d => d.id);
  
  const orders = orderArray.map((id, index) => ({
    id,
    display_order: index,
  }));
  
  // Validar que todos los IDs son del negocio
  for (const order of orders) {
    if (!divisionIds.includes(order.id)) {
      const error = new Error(`División ${order.id} no pertenece al negocio`);
      error.status = 400;
      throw error;
    }
  }
  
  await divisionsRepo.updateDisplayOrders(orders);
  
  return await divisionsRepo.getDivisions(businessId);
}

/**
 * Helper: Generar código único desde el nombre
 */
function generateCodeFromName(name) {
  // Tomar primeras 4 letras en mayúsculas, sin espacios
  const baseCode = name
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .substring(0, 4);
  
  // Si es muy corto, rellenar con X
  return baseCode.padEnd(4, 'X');
}

module.exports = {
  getDivisions,
  getDivisionById,
  getMainDivision,
  createDivision,
  updateDivision,
  deleteDivision,
  convertGroupToDivision,
  reorderDivisions,
};