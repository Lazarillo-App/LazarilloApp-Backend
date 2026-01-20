/**
 * Controller de divisiones (subnegocios)
 * Usa app_businesses con parent_id para jerarquía
 * Incluye métodos para gestión de insumos en subnegocios
 */

const pool = require('../config/db');

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const slugify = (s) =>
  String(s || '')
    .trim()
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 64);

async function ensureUniqueSlug(client, baseSlug, excludeId = null) {
  const base = baseSlug || 'division';
  let slug = base;
  let i = 2;

  while (true) {
    const query = excludeId
      ? `SELECT 1 FROM app_businesses WHERE slug = $1 AND id != $2 LIMIT 1`
      : `SELECT 1 FROM app_businesses WHERE slug = $1 LIMIT 1`;
    const params = excludeId ? [slug, excludeId] : [slug];
    const { rows } = await client.query(query, params);
    if (rows.length === 0) return slug;
    slug = `${base}-${i++}`;
  }
}

async function ensureUniqueCode(client, businessId, baseName, excludeId = null) {
  const base = slugify(baseName) || 'division';
  let code = base;
  let i = 2;

  while (true) {
    const query = excludeId
      ? `SELECT 1 FROM business_divisions WHERE business_id = $1 AND code = $2 AND id != $3 LIMIT 1`
      : `SELECT 1 FROM business_divisions WHERE business_id = $1 AND code = $2 LIMIT 1`;
    const params = excludeId ? [businessId, code, excludeId] : [businessId, code];
    const { rows } = await client.query(query, params);
    if (rows.length === 0) return code;
    code = `${base}-${i++}`;
  }
}

// ============================================================================
// GESTIÓN DE SUBNEGOCIOS
// ============================================================================

/**
 * GET /api/divisions/business/:businessId
 * Lista divisiones de un negocio
 */
exports.getDivisionsByBusiness = async (req, res) => {
  try {
    const businessId = num(req.params.businessId);
    if (!businessId) return res.status(400).json({ ok: false, error: 'invalid_business_id' });

    const { rows } = await pool.query(
      `
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
        COALESCE(
          (SELECT COUNT(*) FROM division_group_assignments dga WHERE dga.division_id = bd.id),
          0
        )::integer as assigned_groups_count
      FROM business_divisions bd
      WHERE bd.business_id = $1
      ORDER BY bd.is_main DESC, bd.display_order ASC, bd.name ASC
      `,
      [businessId]
    );

    res.json({ 
      ok: true, 
      business_id: businessId,
      items: rows 
    });
  } catch (e) {
    console.error('[divisions] getDivisionsByBusiness error:', e);
    res.status(500).json({ ok: false, error: 'internal_error' });
  }
};

/**
 * GET /api/divisions/business/:businessId/main
 * Devuelve el negocio principal (el padre)
 */
exports.getMainDivision = async (req, res) => {
  try {
    const businessId = num(req.params.businessId);
    if (!businessId) return res.status(400).json({ ok: false, error: 'invalid_business_id' });

    const { rows } = await pool.query(
      `SELECT id, name, slug, parent_id FROM app_businesses WHERE id = $1 LIMIT 1`,
      [businessId]
    );

    if (!rows.length) return res.status(404).json({ ok: false, error: 'business_not_found' });

    res.json({ ok: true, division: rows[0] });
  } catch (e) {
    console.error('[divisions] getMainDivision', e);
    res.status(500).json({ ok: false, error: 'error_getting_main_division' });
  }
};

/**
 * GET /api/divisions/:divisionId
 * Obtener detalles de una división
 */
exports.getDivisionById = async (req, res) => {
  try {
    const divisionId = num(req.params.divisionId);
    if (!divisionId) return res.status(400).json({ ok: false, error: 'invalid_division_id' });

    const { rows } = await pool.query(
      `
      SELECT 
        bd.*,
        COALESCE(
          (SELECT COUNT(*) FROM division_group_assignments dga WHERE dga.division_id = bd.id),
          0
        )::integer as assigned_groups_count
      FROM business_divisions bd
      WHERE bd.id = $1
      `,
      [divisionId]
    );

    if (!rows.length) {
      return res.status(404).json({ ok: false, error: 'division_not_found' });
    }

    res.json({ ok: true, division: rows[0] });
  } catch (e) {
    console.error('[divisions] getDivisionById error:', e);
    res.status(500).json({ ok: false, error: 'internal_error' });
  }
};

/**
 * POST /api/divisions
 * Crear nueva división
 * Body: { businessId, name, description?, isMain? }
 */
exports.createDivision = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const businessId = num(req.body?.businessId);
    const name = String(req.body?.name || '').trim();
    const description = String(req.body?.description || '').trim() || null;
    const isMain = !!req.body?.isMain;

    if (!businessId) {
      await client.query('ROLLBACK');
      return res.status(400).json({ ok: false, error: 'business_id requerido' });
    }

    if (!name) {
      await client.query('ROLLBACK');
      return res.status(400).json({ ok: false, error: 'nombre requerido' });
    }

    // Verificar que el negocio existe
    const { rows: bizRows } = await client.query(
      `SELECT id FROM app_businesses WHERE id = $1`,
      [businessId]
    );
    if (!bizRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'business_not_found' });
    }

    // Generar código único
    const code = await ensureUniqueCode(client, businessId, name);

    // Si isMain=true, desmarcar otras divisiones principales
    if (isMain) {
      await client.query(
        `UPDATE business_divisions SET is_main = false WHERE business_id = $1 AND is_main = true`,
        [businessId]
      );
    }

    // Crear división
    const { rows } = await client.query(
      `
      INSERT INTO business_divisions (business_id, name, code, description, is_main, is_active, display_order)
      VALUES ($1, $2, $3, $4, $5, true, 0)
      RETURNING *
      `,
      [businessId, name, code, description, isMain]
    );

    await client.query('COMMIT');

    res.status(201).json({ ok: true, division: rows[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[divisions] createDivision error:', e);
    
    if (e.code === '23505') {
      return res.status(409).json({ ok: false, error: 'division_already_exists' });
    }
    
    res.status(500).json({ ok: false, error: 'internal_error' });
  } finally {
    client.release();
  }
};

/**
 * PUT /api/divisions/:divisionId
 * Actualizar división
 */
exports.updateDivision = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const divisionId = num(req.params.divisionId);
    const name = req.body?.name ? String(req.body.name).trim() : null;
    const description = req.body?.description !== undefined 
      ? String(req.body.description || '').trim() || null 
      : undefined;
    const isActive = req.body?.isActive;

    if (!divisionId) {
      await client.query('ROLLBACK');
      return res.status(400).json({ ok: false, error: 'invalid_division_id' });
    }

    // Verificar que existe
    const { rows: current } = await client.query(
      `SELECT * FROM business_divisions WHERE id = $1`,
      [divisionId]
    );
    if (!current.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'division_not_found' });
    }

    const sets = [];
    const vals = [];
    let i = 1;

    if (name) {
      vals.push(name);
      sets.push(`name = $${i++}`);
      
      // Regenerar code si cambia el nombre
      const newCode = await ensureUniqueCode(client, current[0].business_id, name, divisionId);
      vals.push(newCode);
      sets.push(`code = $${i++}`);
    }

    if (description !== undefined) {
      vals.push(description);
      sets.push(`description = $${i++}`);
    }

    if (typeof isActive === 'boolean') {
      vals.push(isActive);
      sets.push(`is_active = $${i++}`);
    }

    if (sets.length === 0) {
      await client.query('COMMIT');
      return res.json({ ok: true, division: current[0] });
    }

    sets.push(`updated_at = NOW()`);
    vals.push(divisionId);

    const { rows } = await client.query(
      `UPDATE business_divisions SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
      vals
    );

    await client.query('COMMIT');

    res.json({ ok: true, division: rows[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[divisions] updateDivision error:', e);
    res.status(500).json({ ok: false, error: 'internal_error' });
  } finally {
    client.release();
  }
};

/**
 * DELETE /api/divisions/:divisionId
 * Eliminar división
 */
exports.deleteDivision = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const divisionId = num(req.params.divisionId);
    if (!divisionId) {
      await client.query('ROLLBACK');
      return res.status(400).json({ ok: false, error: 'invalid_division_id' });
    }

    // Verificar que no es la división principal
    const { rows: current } = await client.query(
      `SELECT is_main FROM business_divisions WHERE id = $1`,
      [divisionId]
    );

    if (!current.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'division_not_found' });
    }

    if (current[0].is_main) {
      await client.query('ROLLBACK');
      return res.status(400).json({ ok: false, error: 'cannot_delete_main_division' });
    }

    // Eliminar (las FKs con CASCADE limpiarán division_group_assignments)
    await client.query(`DELETE FROM business_divisions WHERE id = $1`, [divisionId]);

    await client.query('COMMIT');

    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[divisions] deleteDivision error:', e);
    res.status(500).json({ ok: false, error: 'internal_error' });
  } finally {
    client.release();
  }
};

// ============================================================================
// JERARQUÍA Y ESTADÍSTICAS (usando funciones SQL)
// ============================================================================

/**
 * GET /api/divisions/business/:businessId/hierarchy
 * Usa la función SQL get_business_hierarchy
 */
exports.getBusinessHierarchy = async (req, res) => {
  try {
    const businessId = num(req.params.businessId);
    if (!businessId) return res.status(400).json({ ok: false, error: 'invalid_business_id' });

    const result = await pool.query(`SELECT * FROM get_business_hierarchy($1)`, [businessId]);
    res.json({ ok: true, hierarchy: result.rows });
  } catch (e) {
    console.error('[divisions] getBusinessHierarchy', e);
    res.status(500).json({ ok: false, error: 'error_getting_hierarchy' });
  }
};

/**
 * GET /api/divisions/business/:businessId/all-subnegocios
 * Usa la función SQL get_all_subnegocios
 */
exports.getAllSubnegocios = async (req, res) => {
  try {
    const businessId = num(req.params.businessId);
    if (!businessId) return res.status(400).json({ ok: false, error: 'invalid_business_id' });

    const result = await pool.query(`SELECT * FROM get_all_subnegocios($1)`, [businessId]);
    res.json({ 
      ok: true, 
      business_id: businessId,
      total: result.rows.length,
      subnegocios: result.rows 
    });
  } catch (e) {
    console.error('[divisions] getAllSubnegocios', e);
    res.status(500).json({ ok: false, error: 'error_getting_subnegocios' });
  }
};

/**
 * GET /api/divisions/business/:businessId/stats
 * Estadísticas del negocio incluyendo subnegocios
 */
exports.getStatsWithSubnegocios = async (req, res) => {
  try {
    const businessId = num(req.params.businessId);
    if (!businessId) return res.status(400).json({ ok: false, error: 'invalid_business_id' });

    const [articulosResult, insumosResult, subResult] = await Promise.all([
      pool.query(`SELECT count_articulos_including_subnegocios($1) as total`, [businessId]),
      pool.query(`SELECT count_insumos_including_subnegocios($1) as total`, [businessId]),
      pool.query(`SELECT * FROM get_all_subnegocios($1)`, [businessId])
    ]);

    res.json({ 
      ok: true, 
      business_id: businessId,
      stats: {
        total_articulos: articulosResult.rows[0]?.total || 0,
        total_insumos: insumosResult.rows[0]?.total || 0,
        total_subnegocios: subResult.rows.length
      },
      subnegocios: subResult.rows
    });
  } catch (e) {
    console.error('[divisions] getStatsWithSubnegocios', e);
    res.status(500).json({ ok: false, error: 'error_getting_stats' });
  }
};

// ============================================================================
// GESTIÓN DE INSUMOS EN SUBNEGOCIOS
// ============================================================================

/**
 * POST /api/divisions/:divisionId/move-insumos
 * Mover insumos específicos a un subnegocio
 * Body: { insumo_ids: number[] }
 */
exports.moveInsumosToSubnegocio = async (req, res) => {
  const client = await pool.connect();
  
  try {
    const targetBusinessId = num(req.params.divisionId);
    const { insumo_ids } = req.body;
    
    if (!targetBusinessId) {
      return res.status(400).json({ ok: false, error: 'invalid_division_id' });
    }
    
    if (!insumo_ids || !Array.isArray(insumo_ids) || insumo_ids.length === 0) {
      return res.status(400).json({ ok: false, error: 'insumo_ids_required' });
    }
    
    await client.query('BEGIN');
    
    const targetCheck = await client.query(
      `SELECT id, name, parent_id FROM app_businesses WHERE id = $1 LIMIT 1`,
      [targetBusinessId]
    );
    
    if (targetCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'target_business_not_found' });
    }
    
    const result = await client.query(`
      UPDATE insumos
      SET business_id = $1
      WHERE id = ANY($2)
      RETURNING id, nombre
    `, [targetBusinessId, insumo_ids]);
    
    await client.query('COMMIT');
    
    res.json({
      ok: true,
      moved_count: result.rowCount,
      moved_insumos: result.rows,
      target_business: targetCheck.rows[0].name,
      message: `${result.rowCount} insumos movidos exitosamente`
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[divisions] moveInsumosToSubnegocio', error);
    res.status(500).json({ ok: false, error: 'error_moving_insumos' });
  } finally {
    client.release();
  }
};

/**
 * POST /api/divisions/business/:businessId/move-insumos-by-rubro
 * Mover todos los insumos de un rubro a un subnegocio
 * Body: { rubro: string, target_business_id: number }
 */
exports.moveInsumosByRubroToSubnegocio = async (req, res) => {
  const client = await pool.connect();
  
  try {
    const sourceBusinessId = num(req.params.businessId);
    const { rubro, target_business_id } = req.body;
    
    if (!sourceBusinessId) {
      return res.status(400).json({ ok: false, error: 'invalid_business_id' });
    }
    
    if (!rubro) {
      return res.status(400).json({ ok: false, error: 'rubro_required' });
    }
    
    if (!target_business_id) {
      return res.status(400).json({ ok: false, error: 'target_business_id_required' });
    }
    
    await client.query('BEGIN');
    
    // Verificar relación padre-hijo entre negocios
    const targetCheck = await client.query(`
      SELECT id, name, parent_id FROM app_businesses 
      WHERE id = $1 
      AND (parent_id = $2 OR id = $2 OR $2 IN (SELECT id FROM app_businesses WHERE parent_id = $1))
      LIMIT 1
    `, [target_business_id, sourceBusinessId]);
    
    if (targetCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'invalid_target_business' });
    }
    
    const result = await client.query(`
      UPDATE insumos
      SET business_id = $1
      WHERE business_id = $2 AND rubro = $3
      RETURNING id, nombre
    `, [target_business_id, sourceBusinessId, rubro]);
    
    await client.query('COMMIT');
    
    res.json({
      ok: true,
      moved_count: result.rowCount,
      rubro,
      target_business: targetCheck.rows[0].name,
      message: `${result.rowCount} insumos del rubro "${rubro}" movidos exitosamente`
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[divisions] moveInsumosByRubroToSubnegocio', error);
    res.status(500).json({ ok: false, error: 'error_moving_insumos' });
  } finally {
    client.release();
  }
};

/**
 * GET /api/divisions/business/:businessId/insumos-stats
 * Estadísticas de insumos por negocio y subnegocios
 */
exports.getInsumosStats = async (req, res) => {
  try {
    const businessId = num(req.params.businessId);
    
    if (!businessId) {
      return res.status(400).json({ ok: false, error: 'invalid_business_id' });
    }
    
    const result = await pool.query(`
      WITH all_businesses AS (
        SELECT id, name, parent_id 
        FROM app_businesses
        WHERE id = $1 OR parent_id = $1
      )
      SELECT 
        b.id,
        b.name,
        b.parent_id,
        COALESCE(COUNT(i.id), 0)::integer as insumos_count,
        CASE 
          WHEN b.parent_id IS NULL THEN 'principal'
          ELSE 'subnegocio'
        END as tipo
      FROM all_businesses b
      LEFT JOIN insumos i ON i.business_id = b.id
      GROUP BY b.id, b.name, b.parent_id
      ORDER BY b.parent_id NULLS FIRST, b.name
    `, [businessId]);
    
    const totalInsumos = result.rows.reduce((sum, r) => sum + r.insumos_count, 0);
    const principalCount = result.rows.find(r => r.tipo === 'principal')?.insumos_count || 0;
    const subnegocios = result.rows.filter(r => r.tipo === 'subnegocio');
    
    res.json({
      ok: true,
      business_id: businessId,
      total_insumos: totalInsumos,
      insumos_en_principal: principalCount,
      insumos_en_subnegocios: totalInsumos - principalCount,
      detalle: result.rows,
      subnegocios_count: subnegocios.length
    });
  } catch (error) {
    console.error('[divisions] getInsumosStats', error);
    res.status(500).json({ ok: false, error: 'error_getting_insumos_stats' });
  }
};

/**
 * GET /api/divisions/business/:businessId/insumos-by-rubro
 * Obtener insumos agrupados por rubro
 */
exports.getInsumosByRubro = async (req, res) => {
  try {
    const businessId = num(req.params.businessId);
    const includeSubnegocios = req.query.includeSubnegocios === 'true';
    
    if (!businessId) {
      return res.status(400).json({ ok: false, error: 'invalid_business_id' });
    }
    
    let query;
    let params;
    
    if (includeSubnegocios) {
      query = `
        WITH all_businesses AS (
          SELECT id FROM app_businesses
          WHERE id = $1 OR parent_id = $1
        )
        SELECT 
          i.rubro,
          COUNT(i.id)::integer as count,
          array_agg(DISTINCT b.name) as negocios
        FROM insumos i
        INNER JOIN app_businesses b ON i.business_id = b.id
        WHERE i.business_id IN (SELECT id FROM all_businesses)
        AND i.rubro IS NOT NULL AND i.rubro != ''
        GROUP BY i.rubro
        ORDER BY count DESC
      `;
      params = [businessId];
    } else {
      query = `
        SELECT 
          rubro,
          COUNT(id)::integer as count
        FROM insumos
        WHERE business_id = $1
        AND rubro IS NOT NULL AND rubro != ''
        GROUP BY rubro
        ORDER BY count DESC
      `;
      params = [businessId];
    }
    
    const result = await pool.query(query, params);
    
    res.json({
      ok: true,
      business_id: businessId,
      include_subnegocios: includeSubnegocios,
      rubros: result.rows,
      total_rubros: result.rows.length
    });
  } catch (error) {
    console.error('[divisions] getInsumosByRubro', error);
    res.status(500).json({ ok: false, error: 'error_getting_insumos_by_rubro' });
  }
};

// ============================================================================
// MOVER ARTÍCULOS Y AGRUPACIONES A SUBNEGOCIOS
// ============================================================================

/**
 * POST /api/divisions/:divisionId/move-articles
 * Mover artículos específicos a un subnegocio
 * Body: { articleIds: number[], sourceBusinessId?: number }
 */
exports.moveArticlesToSubnegocio = async (req, res) => {
  const client = await pool.connect();
  
  try {
    const targetBusinessId = num(req.params.divisionId);
    const { articleIds, sourceBusinessId } = req.body;
    
    if (!targetBusinessId) {
      return res.status(400).json({ ok: false, error: 'invalid_division_id' });
    }
    
    if (!articleIds || !Array.isArray(articleIds) || articleIds.length === 0) {
      return res.status(400).json({ ok: false, error: 'articleIds_required' });
    }
    
    await client.query('BEGIN');
    
    // Verificar que el subnegocio existe
    const targetCheck = await client.query(
      `SELECT id, name, parent_id FROM app_businesses WHERE id = $1 LIMIT 1`,
      [targetBusinessId]
    );
    
    if (targetCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'target_business_not_found' });
    }
    
    const targetBiz = targetCheck.rows[0];
    
    // Construir la query de actualización
    let updateQuery;
    let updateParams;
    
    if (sourceBusinessId) {
      // Si se especifica el negocio origen, solo mover artículos de ese negocio
      updateQuery = `
        UPDATE app_articles
        SET business_id = $1, updated_at = NOW()
        WHERE id = ANY($2::int[])
          AND business_id = $3
        RETURNING id, nombre, codigo
      `;
      updateParams = [targetBusinessId, articleIds, sourceBusinessId];
    } else {
      // Mover sin verificar origen (menos seguro pero más flexible)
      updateQuery = `
        UPDATE app_articles
        SET business_id = $1, updated_at = NOW()
        WHERE id = ANY($2::int[])
        RETURNING id, nombre, codigo
      `;
      updateParams = [targetBusinessId, articleIds];
    }
    
    const result = await client.query(updateQuery, updateParams);
    
    await client.query('COMMIT');
    
    console.log(`[divisions] moveArticlesToSubnegocio: ${result.rowCount} artículos movidos a negocio ${targetBusinessId}`);
    
    res.json({
      ok: true,
      moved_count: result.rowCount,
      target_business_id: targetBusinessId,
      target_business_name: targetBiz.name,
      moved_articles: result.rows,
      message: `${result.rowCount} artículos movidos exitosamente`
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[divisions] moveArticlesToSubnegocio', error);
    res.status(500).json({ ok: false, error: 'error_moving_articles', details: error.message });
  } finally {
    client.release();
  }
};


/**
 * POST /api/divisions/:divisionId/move-agrupacion
 * Mover una agrupación completa (con sus artículos) a un subnegocio
 * Body: { agrupacionId: number, sourceBusinessId: number }
 */
exports.moveAgrupacionToSubnegocio = async (req, res) => {
  const client = await pool.connect();
  
  try {
    const targetBusinessId = num(req.params.divisionId);
    const { agrupacionId, sourceBusinessId } = req.body;
    
    if (!targetBusinessId) {
      return res.status(400).json({ ok: false, error: 'invalid_division_id' });
    }
    
    if (!agrupacionId) {
      return res.status(400).json({ ok: false, error: 'agrupacionId_required' });
    }
    
    await client.query('BEGIN');
    
    // 1. Verificar que el subnegocio destino existe
    const targetCheck = await client.query(
      `SELECT id, name, parent_id FROM app_businesses WHERE id = $1 LIMIT 1`,
      [targetBusinessId]
    );
    
    if (targetCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'target_business_not_found' });
    }
    
    const targetBiz = targetCheck.rows[0];
    
    // 2. Obtener la agrupación y sus artículos
    const agrupQuery = sourceBusinessId
      ? `SELECT id, nombre, articulos, business_id FROM agrupaciones WHERE id = $1 AND business_id = $2`
      : `SELECT id, nombre, articulos, business_id FROM agrupaciones WHERE id = $1`;
    
    const agrupParams = sourceBusinessId ? [agrupacionId, sourceBusinessId] : [agrupacionId];
    const agrupResult = await client.query(agrupQuery, agrupParams);
    
    if (agrupResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'agrupacion_not_found' });
    }
    
    const agrupacion = agrupResult.rows[0];
    const articulos = agrupacion.articulos || [];
    const originalBusinessId = agrupacion.business_id;
    
    // 3. Extraer IDs de artículos
    const articleIds = articulos
      .map(a => {
        const id = a?.id ?? a?.article_id ?? a?.articulo_id ?? a?.articuloId;
        return num(id);
      })
      .filter(id => id !== null);
    
    console.log(`[divisions] moveAgrupacionToSubnegocio: Agrupación "${agrupacion.nombre}" con ${articleIds.length} artículos`);
    
    // 4. Mover artículos al subnegocio
    let movedArticlesCount = 0;
    if (articleIds.length > 0) {
      const moveResult = await client.query(`
        UPDATE app_articles
        SET business_id = $1, updated_at = NOW()
        WHERE id = ANY($2::int[])
          AND business_id = $3
      `, [targetBusinessId, articleIds, originalBusinessId]);
      
      movedArticlesCount = moveResult.rowCount;
      console.log(`[divisions] moveAgrupacionToSubnegocio: ${movedArticlesCount} artículos movidos`);
    }
    
    // 5. Mover la agrupación al subnegocio
    await client.query(`
      UPDATE agrupaciones
      SET business_id = $1, updated_at = NOW()
      WHERE id = $2
    `, [targetBusinessId, agrupacionId]);
    
    console.log(`[divisions] moveAgrupacionToSubnegocio: Agrupación actualizada`);
    
    await client.query('COMMIT');
    
    res.json({
      ok: true,
      message: 'Agrupación movida correctamente',
      agrupacion: {
        id: agrupacionId,
        nombre: agrupacion.nombre,
      },
      target_business: {
        id: targetBusinessId,
        name: targetBiz.name,
      },
      source_business_id: originalBusinessId,
      articles_moved: movedArticlesCount,
      articles_in_agrupacion: articleIds.length,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[divisions] moveAgrupacionToSubnegocio', error);
    res.status(500).json({ ok: false, error: 'error_moving_agrupacion', details: error.message });
  } finally {
    client.release();
  }
};


/**
 * POST /api/divisions/move-agrupacion-complete
 * 
 * Mueve una agrupación (business_group) a una división:
 * 1. Crea división nueva SI es necesario
 * 2. Asigna el grupo a la división (division_group_assignments)
 * 3. Mueve los artículos actualizando app_articles.division_id
 * 
 * Body: {
 *   agrupacionId: number,          // ID del business_group a mover
 *   sourceBusinessId: number,      // ID del negocio origen
 *   targetBusinessId?: number,     // ID de división existente (opcional)
 *   createNew: boolean,            // true = crear nueva división
 *   newBusinessName?: string       // Nombre si createNew=true
 * }
 */
exports.moveAgrupacionComplete = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const {
      agrupacionId,
      sourceBusinessId,
      targetBusinessId,
      createNew,
      newBusinessName
    } = req.body || {};

    // Validaciones
    const agrupId = num(agrupacionId);
    const sourceBizId = num(sourceBusinessId);

    if (!agrupId || !sourceBizId) {
      await client.query('ROLLBACK');
      return res.status(400).json({ 
        ok: false, 
        error: 'agrupacionId y sourceBusinessId son requeridos' 
      });
    }

    // Verificar que la agrupación existe
    const { rows: groupRows } = await client.query(
      `SELECT * FROM business_groups WHERE id = $1 AND business_id = $2`,
      [agrupId, sourceBizId]
    );

    if (!groupRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'agrupacion_not_found' });
    }

    const grupo = groupRows[0];

    let targetDivision = null;

    // ========================================================================
    // PASO 1: Obtener o crear la división destino
    // ========================================================================

    if (createNew) {
      // Crear nueva división
      const nombre = String(newBusinessName || '').trim();
      if (!nombre) {
        await client.query('ROLLBACK');
        return res.status(400).json({ ok: false, error: 'nombre requerido para nueva división' });
      }

      const code = await ensureUniqueCode(client, sourceBizId, nombre);

      const { rows: newDivRows } = await client.query(
        `
        INSERT INTO business_divisions (business_id, name, code, is_main, is_active, source_group_id)
        VALUES ($1, $2, $3, false, true, $4)
        RETURNING *
        `,
        [sourceBizId, nombre, code, agrupId]
      );

      targetDivision = newDivRows[0];

    } else {
      // Usar división existente
      const targetDivId = num(targetBusinessId);
      if (!targetDivId) {
        await client.query('ROLLBACK');
        return res.status(400).json({ ok: false, error: 'targetBusinessId requerido cuando createNew=false' });
      }

      const { rows: divRows } = await client.query(
        `SELECT * FROM business_divisions WHERE id = $1 AND business_id = $2`,
        [targetDivId, sourceBizId]
      );

      if (!divRows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ ok: false, error: 'target_division_not_found' });
      }

      targetDivision = divRows[0];
    }

    // ========================================================================
    // PASO 2: Asignar el grupo a la división (division_group_assignments)
    // ========================================================================

    await client.query(
      `
      INSERT INTO division_group_assignments (division_id, group_id, is_customized)
      VALUES ($1, $2, false)
      ON CONFLICT (division_id, group_id) DO NOTHING
      `,
      [targetDivision.id, agrupId]
    );

    // ========================================================================
    // PASO 3: Mover artículos del grupo a la división
    // ========================================================================

    const { rows: updateResult } = await client.query(
      `
      UPDATE app_articles
      SET division_id = $1
      WHERE id IN (
        SELECT article_id 
        FROM article_groups 
        WHERE group_id = $2
      )
      AND business_id = $3
      RETURNING id
      `,
      [targetDivision.id, agrupId, sourceBizId]
    );

    const articlesMoved = updateResult.length;

    // ========================================================================
    // PASO 4: Actualizar sales_daily_items.division_id
    // ========================================================================

    await client.query(
      `
      UPDATE sales_daily_items
      SET division_id = $1
      WHERE article_id IN (
        SELECT article_id 
        FROM article_groups 
        WHERE group_id = $2
      )
      AND business_id = $3
      `,
      [targetDivision.id, agrupId, sourceBizId]
    );

    await client.query('COMMIT');

    // Respuesta
    res.json({
      ok: true,
      created_new_business: createNew,
      target_business: {
        id: targetDivision.id,
        name: targetDivision.name,
        code: targetDivision.code,
        is_main: targetDivision.is_main
      },
      group: {
        id: grupo.id,
        name: grupo.name
      },
      articles_moved: articlesMoved
    });

  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[divisions] moveAgrupacionComplete error:', e);
    res.status(500).json({ ok: false, error: 'internal_error', detail: e.message });
  } finally {
    client.release();
  }
};

/* GET /api/divisions/:divisionId/groups
 * Listar grupos asignados a una división
 */
exports.getGroupsByDivision = async (req, res) => {
  try {
    const divisionId = num(req.params.divisionId);
    if (!divisionId) return res.status(400).json({ ok: false, error: 'invalid_division_id' });

    const { rows } = await pool.query(
      `
      SELECT 
        bg.id,
        bg.name,
        bg.description,
        bg.config,
        dga.is_customized,
        dga.created_at as assigned_at,
        COALESCE(
          (SELECT COUNT(*) FROM article_groups ag WHERE ag.group_id = bg.id),
          0
        )::integer as article_count
      FROM division_group_assignments dga
      INNER JOIN business_groups bg ON bg.id = dga.group_id
      WHERE dga.division_id = $1
      ORDER BY bg.name ASC
      `,
      [divisionId]
    );

    res.json({ ok: true, division_id: divisionId, groups: rows });
  } catch (e) {
    console.error('[divisions] getGroupsByDivision error:', e);
    res.status(500).json({ ok: false, error: 'internal_error' });
  }
};

/**
 * POST /api/divisions/:divisionId/assign-group
 * Asignar un grupo a una división
 */
exports.assignGroupToDivision = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const divisionId = num(req.params.divisionId);
    const groupId = num(req.body?.groupId);

    if (!divisionId || !groupId) {
      await client.query('ROLLBACK');
      return res.status(400).json({ ok: false, error: 'division_id y group_id requeridos' });
    }

    // Asignar grupo a división
    await client.query(
      `
      INSERT INTO division_group_assignments (division_id, group_id, is_customized)
      VALUES ($1, $2, false)
      ON CONFLICT (division_id, group_id) DO NOTHING
      `,
      [divisionId, groupId]
    );

    // Actualizar artículos
    const { rows: updateResult } = await client.query(
      `
      UPDATE app_articles
      SET division_id = $1
      WHERE id IN (
        SELECT article_id FROM article_groups WHERE group_id = $2
      )
      RETURNING id
      `,
      [divisionId, groupId]
    );

    await client.query('COMMIT');

    res.json({ 
      ok: true, 
      division_id: divisionId,
      group_id: groupId,
      articles_updated: updateResult.length
    });

  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[divisions] assignGroupToDivision error:', e);
    res.status(500).json({ ok: false, error: 'internal_error' });
  } finally {
    client.release();
  }
};

/**
 * DELETE /api/divisions/:divisionId/groups/:groupId
 * Quitar un grupo de una división
 */
exports.removeGroupFromDivision = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const divisionId = num(req.params.divisionId);
    const groupId = num(req.params.groupId);

    if (!divisionId || !groupId) {
      await client.query('ROLLBACK');
      return res.status(400).json({ ok: false, error: 'division_id y group_id requeridos' });
    }

    // Eliminar asignación
    await client.query(
      `DELETE FROM division_group_assignments WHERE division_id = $1 AND group_id = $2`,
      [divisionId, groupId]
    );

    // Quitar division_id de los artículos (vuelven al pool general)
    const { rows: updateResult } = await client.query(
      `
      UPDATE app_articles
      SET division_id = NULL
      WHERE id IN (
        SELECT article_id FROM article_groups WHERE group_id = $1
      )
      AND division_id = $2
      RETURNING id
      `,
      [groupId, divisionId]
    );

    await client.query('COMMIT');

    res.json({ 
      ok: true, 
      division_id: divisionId,
      group_id: groupId,
      articles_updated: updateResult.length
    });

  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[divisions] removeGroupFromDivision error:', e);
    res.status(500).json({ ok: false, error: 'internal_error' });
  } finally {
    client.release();
  }
};

module.exports = {
  getDivisionsByBusiness: exports.getDivisionsByBusiness,
  createDivision: exports.createDivision,
  getDivisionById: exports.getDivisionById,
  updateDivision: exports.updateDivision,
  deleteDivision: exports.deleteDivision,
  moveAgrupacionComplete: exports.moveAgrupacionComplete,
  getGroupsByDivision: exports.getGroupsByDivision,
  assignGroupToDivision: exports.assignGroupToDivision,
  removeGroupFromDivision: exports.removeGroupFromDivision,
};