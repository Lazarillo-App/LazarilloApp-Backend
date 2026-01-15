/**
 * Rutas de divisiones - Endpoints API
 */

const express = require('express');
const router = express.Router();
const divisionService = require('../services/divisionService');

/**
 * GET /api/divisions/business/:businessId
 * Obtener todas las divisiones de un negocio
 * 
 * Query params:
 *   - includeInactive (boolean): incluir divisiones inactivas
 *   - includeStats (boolean): incluir estadísticas
 */
router.get('/business/:businessId', async (req, res, next) => {
  try {
    const businessId = parseInt(req.params.businessId, 10);
    const includeInactive = req.query.includeInactive === 'true';
    const includeStats = req.query.includeStats === 'true';
    
    const divisions = await divisionService.getDivisions(businessId, {
      includeInactive,
      includeStats,
    });
    
    const hasMain = divisions.some(d => d.is_main);
    
    res.json({
      divisions,
      total: divisions.length,
      business_id: businessId,
      has_main_division: hasMain,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/divisions/:divisionId
 * Obtener una división específica
 */
router.get('/:divisionId', async (req, res, next) => {
  try {
    const divisionId = parseInt(req.params.divisionId, 10);
    const division = await divisionService.getDivisionById(divisionId);
    
    res.json(division);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/divisions/business/:businessId/main
 * Obtener la división principal de un negocio
 */
router.get('/business/:businessId/main', async (req, res, next) => {
  try {
    const businessId = parseInt(req.params.businessId, 10);
    const division = await divisionService.getMainDivision(businessId);
    
    res.json(division);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/divisions
 * Crear una nueva división
 * 
 * Body:
 * {
 *   "business_id": 31,
 *   "name": "Cafetería",
 *   "code": "CAFE",
 *   "description": "Sección de cafetería",
 *   "is_active": true,
 *   "display_order": 1,
 *   "config": {
 *     "color": "#8B4513",
 *     "icon": "☕",
 *     "margin_percent": 35
 *   }
 * }
 */
router.post('/', async (req, res, next) => {
  try {
    const divisionData = req.body;
    
    // Validaciones básicas
    if (!divisionData.business_id) {
      return res.status(400).json({ error: 'business_id es requerido' });
    }
    if (!divisionData.name) {
      return res.status(400).json({ error: 'name es requerido' });
    }
    if (!divisionData.code) {
      return res.status(400).json({ error: 'code es requerido' });
    }
    
    const division = await divisionService.createDivision(divisionData);
    
    res.status(201).json(division);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/divisions/convert-from-group
 * Convertir una agrupación existente en división
 * 
 * Body:
 * {
 *   "business_id": 31,
 *   "group_id": 5,
 *   "new_name": "Bebidas Premium",
 *   "new_code": "BPREM",
 *   "inherit_config": true,
 *   "move_articles": true
 * }
 */
router.post('/convert-from-group', async (req, res, next) => {
  try {
    const conversionData = req.body;
    
    // Validaciones básicas
    if (!conversionData.business_id) {
      return res.status(400).json({ error: 'business_id es requerido' });
    }
    if (!conversionData.group_id) {
      return res.status(400).json({ error: 'group_id es requerido' });
    }
    
    const result = await divisionService.convertGroupToDivision(conversionData);
    
    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/divisions/:divisionId
 * Actualizar una división
 * 
 * Body (todos los campos opcionales):
 * {
 *   "name": "Cafetería & Postres",
 *   "code": "CAFE",
 *   "description": "Sección renovada",
 *   "is_active": true,
 *   "display_order": 2,
 *   "config": {
 *     "color": "#A0522D",
 *     "icon": "🍰"
 *   }
 * }
 */
router.put('/:divisionId', async (req, res, next) => {
  try {
    const divisionId = parseInt(req.params.divisionId, 10);
    const updates = req.body;
    
    const division = await divisionService.updateDivision(divisionId, updates);
    
    res.json(division);
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/divisions/:divisionId
 * Eliminar una división
 * 
 * Los artículos y ventas se mueven automáticamente a la división principal
 */
router.delete('/:divisionId', async (req, res, next) => {
  try {
    const divisionId = parseInt(req.params.divisionId, 10);
    
    const result = await divisionService.deleteDivision(divisionId);
    
    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/divisions/business/:businessId/reorder
 * Reordenar divisiones
 * 
 * Body:
 * {
 *   "order": [1, 5, 3, 7, 2]
 * }
 */
router.post('/business/:businessId/reorder', async (req, res, next) => {
  try {
    const businessId = parseInt(req.params.businessId, 10);
    const { order } = req.body;
    
    if (!Array.isArray(order)) {
      return res.status(400).json({ error: 'order debe ser un array' });
    }
    
    const divisions = await divisionService.reorderDivisions(businessId, order);
    
    res.json(divisions);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/divisions/move-articles
 * Mover todos los artículos de una agrupación a una división
 * 
 * Body:
 * {
 *   "business_id": 31,
 *   "group_id": 5,
 *   "division_id": 14
 * }
 */
router.post('/move-articles', async (req, res, next) => {
  try {
    const { business_id, group_id, division_id } = req.body;
    
    // Validaciones básicas
    if (!business_id) {
      return res.status(400).json({ error: 'business_id es requerido' });
    }
    if (!group_id) {
      return res.status(400).json({ error: 'group_id es requerido' });
    }
    if (!division_id) {
      return res.status(400).json({ error: 'division_id es requerido' });
    }
    
    // Verificar que la división existe
    const division = await divisionService.getDivisionById(division_id);
    if (!division || division.business_id !== business_id) {
      return res.status(404).json({ error: 'División no encontrada o no pertenece al negocio' });
    }
    
    // Obtener artículos de la agrupación
    const articlesQuery = `
      SELECT DISTINCT article_id
      FROM article_groups
      WHERE group_id = $1 AND business_id = $2
    `;
    
    const pool = require('../config/db');
    const articlesResult = await pool.query(articlesQuery, [group_id, business_id]);
    const articleIds = articlesResult.rows.map(r => r.article_id);
    
    if (articleIds.length === 0) {
      return res.json({
        moved: 0,
        errors: [],
        message: 'No hay artículos en esta agrupación',
      });
    }
    
    // Mover artículos a la división
    const updateQuery = `
      UPDATE app_articles
      SET division_id = $1
      WHERE id = ANY($2) AND business_id = $3
      RETURNING id
    `;
    
    const updateResult = await pool.query(updateQuery, [
      division_id,
      articleIds,
      business_id,
    ]);
    
    const movedCount = updateResult.rowCount;
    
    res.json({
      moved: movedCount,
      errors: [],
      message: `${movedCount} artículos movidos correctamente`,
      division_id,
      division_name: division.name,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;