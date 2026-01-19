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

// ============================================================================
// GESTIÓN DE SUBNEGOCIOS
// ============================================================================

/**
 * GET /api/divisions/business/:businessId
 * Lista divisiones (hijas directas) de un negocio principal
 */
exports.getDivisionsByBusiness = async (req, res) => {
  try {
    const businessId = num(req.params.businessId);
    if (!businessId) return res.status(400).json({ ok: false, error: 'invalid_business_id' });

    const parentQuery = await pool.query(
      `SELECT id, name, slug, parent_id FROM app_businesses WHERE id = $1 LIMIT 1`,
      [businessId]
    );
    
    if (!parentQuery.rows.length) {
      return res.status(404).json({ ok: false, error: 'business_not_found' });
    }

    const { rows } = await pool.query(
      `
      SELECT 
        b.id, 
        b.name, 
        b.slug, 
        b.parent_id,
        b.created_at,
        b.updated_at,
        COALESCE(art.count, 0)::integer as article_count,
        COALESCE(ins.count, 0)::integer as insumo_count
      FROM app_businesses b
      LEFT JOIN (
        SELECT business_id, COUNT(*) as count 
        FROM app_articles 
        GROUP BY business_id
      ) art ON art.business_id = b.id
      LEFT JOIN (
        SELECT business_id, COUNT(*) as count 
        FROM insumos 
        GROUP BY business_id
      ) ins ON ins.business_id = b.id
      WHERE b.parent_id = $1
      ORDER BY b.name ASC
      `,
      [businessId]
    );

    res.json({
      ok: true,
      business_id: businessId,
      business_name: parentQuery.rows[0].name,
      total: rows.length,
      has_main_division: true,
      divisions: rows,
    });
  } catch (e) {
    console.error('[divisions] getDivisionsByBusiness', e);
    res.status(500).json({ ok: false, error: 'error_getting_divisions' });
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
 * Obtener una división por ID
 */
exports.getDivisionById = async (req, res) => {
  try {
    const divisionId = num(req.params.divisionId);
    if (!divisionId) return res.status(400).json({ ok: false, error: 'invalid_division_id' });

    const { rows } = await pool.query(
      `
      SELECT 
        b.id, 
        b.name, 
        b.slug, 
        b.parent_id,
        b.created_at,
        b.updated_at,
        p.name as parent_name,
        p.slug as parent_slug,
        COALESCE(art.count, 0)::integer as article_count,
        COALESCE(ins.count, 0)::integer as insumo_count
      FROM app_businesses b
      LEFT JOIN app_businesses p ON b.parent_id = p.id
      LEFT JOIN (
        SELECT business_id, COUNT(*) as count 
        FROM app_articles 
        GROUP BY business_id
      ) art ON art.business_id = b.id
      LEFT JOIN (
        SELECT business_id, COUNT(*) as count 
        FROM insumos 
        GROUP BY business_id
      ) ins ON ins.business_id = b.id
      WHERE b.id = $1 
      LIMIT 1
      `,
      [divisionId]
    );

    if (!rows.length) return res.status(404).json({ ok: false, error: 'division_not_found' });

    res.json({ ok: true, division: rows[0] });
  } catch (e) {
    console.error('[divisions] getDivisionById', e);
    res.status(500).json({ ok: false, error: 'error_getting_division' });
  }
};

/**
 * POST /api/divisions
 * Crear un subnegocio
 * Body: { parent_business_id, name, slug? }
 */
exports.createDivision = async (req, res) => {
  const client = await pool.connect();
  try {
    const parentId = num(req.body?.parent_business_id);
    const name = String(req.body?.name || '').trim();
    const slugInput = String(req.body?.slug || '').trim();

    if (!parentId) return res.status(400).json({ ok: false, error: 'parent_business_id_required' });
    if (!name) return res.status(400).json({ ok: false, error: 'name_required' });

    await client.query('BEGIN');

    const parentCheck = await client.query(
      `SELECT id, name, parent_id FROM app_businesses WHERE id = $1 LIMIT 1`,
      [parentId]
    );
    if (!parentCheck.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'parent_business_not_found' });
    }

    const nameCheck = await client.query(
      `SELECT id FROM app_businesses WHERE parent_id = $1 AND LOWER(name) = LOWER($2) LIMIT 1`,
      [parentId, name]
    );
    if (nameCheck.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ ok: false, error: 'name_already_exists' });
    }

    const baseSlug = slugInput ? slugify(slugInput) : slugify(name);
    const slug = await ensureUniqueSlug(client, baseSlug);

    const ins = await client.query(
      `
      INSERT INTO app_businesses (name, slug, parent_id, props, created_at, updated_at)
      VALUES ($1, $2, $3, '{}', NOW(), NOW())
      RETURNING id, name, slug, parent_id, created_at, updated_at
      `,
      [name, slug, parentId]
    );

    await client.query('COMMIT');
    
    res.status(201).json({ 
      ok: true, 
      division: ins.rows[0],
      parent_name: parentCheck.rows[0].name
    });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[divisions] createDivision', e);
    if (e.code === '23505') return res.status(409).json({ ok: false, error: 'slug_already_exists' });
    res.status(500).json({ ok: false, error: 'error_creating_division' });
  } finally {
    client.release();
  }
};

/**
 * PUT /api/divisions/:divisionId
 * Actualizar un subnegocio
 * Body: { name?, slug? }
 */
exports.updateDivision = async (req, res) => {
  const client = await pool.connect();
  try {
    const divisionId = num(req.params.divisionId);
    if (!divisionId) return res.status(400).json({ ok: false, error: 'invalid_division_id' });

    const name = req.body?.name != null ? String(req.body.name).trim() : null;
    const slugInput = req.body?.slug != null ? String(req.body.slug).trim() : null;

    if (!name && !slugInput) {
      return res.status(400).json({ ok: false, error: 'nothing_to_update' });
    }

    await client.query('BEGIN');

    const current = await client.query(
      `SELECT id, name, slug, parent_id FROM app_businesses WHERE id = $1 LIMIT 1`,
      [divisionId]
    );
    if (!current.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'division_not_found' });
    }

    const division = current.rows[0];

    if (name && name.toLowerCase() !== division.name.toLowerCase() && division.parent_id) {
      const nameCheck = await client.query(
        `SELECT id FROM app_businesses WHERE parent_id = $1 AND LOWER(name) = LOWER($2) AND id != $3 LIMIT 1`,
        [division.parent_id, name, divisionId]
      );
      if (nameCheck.rows.length) {
        await client.query('ROLLBACK');
        return res.status(409).json({ ok: false, error: 'name_already_exists' });
      }
    }

    let newSlug = null;
    if (slugInput && slugInput !== division.slug) {
      newSlug = await ensureUniqueSlug(client, slugify(slugInput), divisionId);
    }

    const upd = await client.query(
      `
      UPDATE app_businesses
      SET
        name = COALESCE($1, name),
        slug = COALESCE($2, slug),
        updated_at = NOW()
      WHERE id = $3
      RETURNING id, name, slug, parent_id, created_at, updated_at
      `,
      [name || null, newSlug, divisionId]
    );

    await client.query('COMMIT');
    res.json({ ok: true, division: upd.rows[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[divisions] updateDivision', e);
    if (e.code === '23505') return res.status(409).json({ ok: false, error: 'slug_already_exists' });
    res.status(500).json({ ok: false, error: 'error_updating_division' });
  } finally {
    client.release();
  }
};

/**
 * DELETE /api/divisions/:divisionId
 * Eliminar un subnegocio - Los artículos e insumos se mueven al padre
 */
exports.deleteDivision = async (req, res) => {
  const client = await pool.connect();
  try {
    const divisionId = num(req.params.divisionId);
    if (!divisionId) return res.status(400).json({ ok: false, error: 'invalid_division_id' });

    await client.query('BEGIN');

    const div = await client.query(
      `SELECT id, name, parent_id FROM app_businesses WHERE id = $1 LIMIT 1`,
      [divisionId]
    );
    if (!div.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'division_not_found' });
    }

    const parentId = div.rows[0].parent_id;
    const divisionName = div.rows[0].name;

    if (!parentId) {
      await client.query('ROLLBACK');
      return res.status(400).json({ ok: false, error: 'cannot_delete_main_business' });
    }

    const childCheck = await client.query(
      `SELECT id, name FROM app_businesses WHERE parent_id = $1 LIMIT 5`,
      [divisionId]
    );
    if (childCheck.rows.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ 
        ok: false, 
        error: 'division_has_children',
        children: childCheck.rows.map(c => c.name)
      });
    }

    // Mover artículos al padre
    const movedArticles = await client.query(
      `UPDATE app_articles SET business_id = $1 WHERE business_id = $2 RETURNING id`,
      [parentId, divisionId]
    );

    // Mover insumos al padre
    const movedInsumos = await client.query(
      `UPDATE insumos SET business_id = $1 WHERE business_id = $2 RETURNING id`,
      [parentId, divisionId]
    );

    const parentInfo = await client.query(
      `SELECT name FROM app_businesses WHERE id = $1`,
      [parentId]
    );

    await client.query(`DELETE FROM app_businesses WHERE id = $1`, [divisionId]);

    await client.query('COMMIT');
    
    res.json({
      ok: true,
      message: `División "${divisionName}" eliminada`,
      moved_to: parentInfo.rows[0]?.name || 'Principal',
      moved_articles: movedArticles.rowCount,
      moved_insumos: movedInsumos.rowCount,
    });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[divisions] deleteDivision', e);
    res.status(500).json({ ok: false, error: 'error_deleting_division' });
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
 * Endpoint completo: crea subnegocio si es necesario y mueve agrupación
 * Body: { 
 *   agrupacionId: number, 
 *   sourceBusinessId: number,
 *   targetBusinessId?: number,  // Si existe, usa este
 *   createNew?: boolean,        // Si true, crea nuevo subnegocio
 *   newBusinessName?: string    // Nombre del nuevo subnegocio
 * }
 */
exports.moveAgrupacionComplete = async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { 
      agrupacionId, 
      sourceBusinessId, 
      targetBusinessId, 
      createNew, 
      newBusinessName 
    } = req.body;
    
    if (!agrupacionId) {
      return res.status(400).json({ ok: false, error: 'agrupacionId_required' });
    }
    
    if (!sourceBusinessId) {
      return res.status(400).json({ ok: false, error: 'sourceBusinessId_required' });
    }
    
    if (!targetBusinessId && !createNew) {
      return res.status(400).json({ ok: false, error: 'targetBusinessId_or_createNew_required' });
    }
    
    if (createNew && !newBusinessName) {
      return res.status(400).json({ ok: false, error: 'newBusinessName_required_when_createNew' });
    }
    
    await client.query('BEGIN');
    
    let finalTargetId = targetBusinessId;
    let targetName = null;
    let createdNewBusiness = false;
    
    // 1. Crear subnegocio si es necesario
    if (createNew && newBusinessName) {
      const name = String(newBusinessName).trim();
      const baseSlug = slugify(name);
      const slug = await ensureUniqueSlug(client, baseSlug);
      
      const createResult = await client.query(`
        INSERT INTO app_businesses (name, slug, parent_id, props, created_at, updated_at)
        VALUES ($1, $2, $3, '{}', NOW(), NOW())
        RETURNING id, name, slug
      `, [name, slug, sourceBusinessId]);
      
      finalTargetId = createResult.rows[0].id;
      targetName = createResult.rows[0].name;
      createdNewBusiness = true;
      
      console.log(`[divisions] moveAgrupacionComplete: Subnegocio creado: ${finalTargetId} - ${targetName}`);
    } else {
      // Verificar que el subnegocio existe
      const targetCheck = await client.query(
        `SELECT id, name FROM app_businesses WHERE id = $1 LIMIT 1`,
        [finalTargetId]
      );
      
      if (targetCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ ok: false, error: 'target_business_not_found' });
      }
      
      targetName = targetCheck.rows[0].name;
    }
    
    // 2. Obtener la agrupación
    const agrupResult = await client.query(`
      SELECT id, nombre, articulos, business_id 
      FROM agrupaciones 
      WHERE id = $1 AND business_id = $2
    `, [agrupacionId, sourceBusinessId]);
    
    if (agrupResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'agrupacion_not_found' });
    }
    
    const agrupacion = agrupResult.rows[0];
    const articulos = agrupacion.articulos || [];
    
    // 3. Extraer IDs de artículos
    const articleIds = articulos
      .map(a => {
        const id = a?.id ?? a?.article_id ?? a?.articulo_id ?? a?.articuloId;
        return num(id);
      })
      .filter(id => id !== null);
    
    // 4. Mover artículos
    let movedArticlesCount = 0;
    if (articleIds.length > 0) {
      const moveResult = await client.query(`
        UPDATE app_articles
        SET business_id = $1, updated_at = NOW()
        WHERE id = ANY($2::int[])
          AND business_id = $3
      `, [finalTargetId, articleIds, sourceBusinessId]);
      
      movedArticlesCount = moveResult.rowCount;
    }
    
    // 5. Mover la agrupación
    await client.query(`
      UPDATE agrupaciones
      SET business_id = $1, updated_at = NOW()
      WHERE id = $2
    `, [finalTargetId, agrupacionId]);
    
    await client.query('COMMIT');
    
    console.log(`[divisions] moveAgrupacionComplete: Completado - ${movedArticlesCount} artículos, agrupación "${agrupacion.nombre}" → "${targetName}"`);
    
    res.json({
      ok: true,
      message: 'Agrupación movida correctamente',
      agrupacion: {
        id: agrupacionId,
        nombre: agrupacion.nombre,
      },
      target_business: {
        id: finalTargetId,
        name: targetName,
      },
      source_business_id: sourceBusinessId,
      articles_moved: movedArticlesCount,
      articles_in_agrupacion: articleIds.length,
      created_new_business: createdNewBusiness,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[divisions] moveAgrupacionComplete', error);
    res.status(500).json({ ok: false, error: 'error_moving_agrupacion', details: error.message });
  } finally {
    client.release();
  }
};