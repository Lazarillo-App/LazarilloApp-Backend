/**
 * Controller de divisiones (subnegocios)
 * ✅ Modelo NUEVO: business_divisions + division_group_assignments
 * ❌ NO usa app_businesses.parent_id como jerarquía de subnegocios
 *
 * Importante:
 * - Artículos se mueven por app_articles.division_id (NO business_id)
 * - Grupos se asignan con division_group_assignments
 */

const pool = require('../config/db');

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const slugifyCode = (s) =>
  String(s || '')
    .trim()
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 64);

async function ensureUniqueCode(client, businessId, baseName, excludeId = null) {
  const base = slugifyCode(baseName) || 'division';
  let code = base;
  let i = 2;

  while (true) {
    const q = excludeId
      ? `SELECT 1 FROM business_divisions WHERE business_id=$1 AND code=$2 AND id<>$3 LIMIT 1`
      : `SELECT 1 FROM business_divisions WHERE business_id=$1 AND code=$2 LIMIT 1`;
    const params = excludeId ? [businessId, code, excludeId] : [businessId, code];

    const { rows } = await client.query(q, params);
    if (rows.length === 0) return code;

    code = `${base}-${i++}`;
  }
}

// ============================================================================
// CRUD DIVISIONES
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

    res.json({ ok: true, business_id: businessId, items: rows });
  } catch (e) {
    console.error('[divisions] getDivisionsByBusiness error:', e);
    res.status(500).json({ ok: false, error: 'internal_error' });
  }
};

/**
 * GET /api/divisions/business/:businessId/main
 * Devuelve la división principal del negocio
 */
exports.getMainDivision = async (req, res) => {
  try {
    const businessId = num(req.params.businessId);
    if (!businessId) return res.status(400).json({ ok: false, error: 'invalid_business_id' });

    const { rows } = await pool.query(
      `
      SELECT *
      FROM business_divisions
      WHERE business_id = $1 AND is_main = true AND is_active = true
      LIMIT 1
      `,
      [businessId]
    );

    if (!rows.length) return res.status(404).json({ ok: false, error: 'main_division_not_found' });

    res.json({ ok: true, division: rows[0] });
  } catch (e) {
    console.error('[divisions] getMainDivision', e);
    res.status(500).json({ ok: false, error: 'error_getting_main_division' });
  }
};

/**
 * GET /api/divisions/:divisionId
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

    if (!rows.length) return res.status(404).json({ ok: false, error: 'division_not_found' });

    res.json({ ok: true, division: rows[0] });
  } catch (e) {
    console.error('[divisions] getDivisionById error:', e);
    res.status(500).json({ ok: false, error: 'internal_error' });
  }
};

/**
 * POST /api/divisions
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

    // si isMain=true, desmarcar otras principales
    if (isMain) {
      await client.query(
        `UPDATE business_divisions SET is_main=false WHERE business_id=$1 AND is_main=true`,
        [businessId]
      );
    }

    const code = await ensureUniqueCode(client, businessId, name);

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
    if (e.code === '23505') return res.status(409).json({ ok: false, error: 'division_already_exists' });
    res.status(500).json({ ok: false, error: 'internal_error' });
  } finally {
    client.release();
  }
};

/**
 * PUT /api/divisions/:divisionId
 */
exports.updateDivision = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const divisionId = num(req.params.divisionId);
    if (!divisionId) {
      await client.query('ROLLBACK');
      return res.status(400).json({ ok: false, error: 'invalid_division_id' });
    }

    const { rows: currentRows } = await client.query(
      `SELECT * FROM business_divisions WHERE id=$1 LIMIT 1`,
      [divisionId]
    );
    if (!currentRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'division_not_found' });
    }
    const current = currentRows[0];

    const name = req.body?.name ? String(req.body.name).trim() : null;
    const description = req.body?.description !== undefined
      ? String(req.body.description || '').trim() || null
      : undefined;
    const isActive = req.body?.isActive;

    const sets = [];
    const vals = [];
    let i = 1;

    if (name) {
      vals.push(name);
      sets.push(`name = $${i++}`);

      const newCode = await ensureUniqueCode(client, current.business_id, name, divisionId);
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

    if (!sets.length) {
      await client.query('COMMIT');
      return res.json({ ok: true, division: current });
    }

    sets.push(`updated_at = NOW()`);
    vals.push(divisionId);

    const { rows } = await client.query(
      `UPDATE business_divisions SET ${sets.join(', ')} WHERE id=$${i} RETURNING *`,
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

    const { rows } = await client.query(
      `SELECT is_main FROM business_divisions WHERE id=$1 LIMIT 1`,
      [divisionId]
    );
    if (!rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'division_not_found' });
    }
    if (rows[0].is_main) {
      await client.query('ROLLBACK');
      return res.status(400).json({ ok: false, error: 'cannot_delete_main_division' });
    }

    await client.query(`DELETE FROM business_divisions WHERE id=$1`, [divisionId]);

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
// JERARQUÍA Y ESTADÍSTICAS (si tus funciones SQL existen)
// ============================================================================

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

exports.getAllSubnegocios = async (req, res) => {
  try {
    const businessId = num(req.params.businessId);
    if (!businessId) return res.status(400).json({ ok: false, error: 'invalid_business_id' });

    const result = await pool.query(`SELECT * FROM get_all_subnegocios($1)`, [businessId]);
    res.json({ ok: true, business_id: businessId, total: result.rows.length, subnegocios: result.rows });
  } catch (e) {
    console.error('[divisions] getAllSubnegocios', e);
    res.status(500).json({ ok: false, error: 'error_getting_subnegocios' });
  }
};

exports.getStatsWithSubnegocios = async (req, res) => {
  try {
    const businessId = num(req.params.businessId);
    if (!businessId) return res.status(400).json({ ok: false, error: 'invalid_business_id' });

    const [articulosResult, insumosResult, subResult] = await Promise.all([
      pool.query(`SELECT count_articulos_including_subnegocios($1) as total`, [businessId]),
      pool.query(`SELECT count_insumos_including_subnegocios($1) as total`, [businessId]),
      pool.query(`SELECT * FROM get_all_subnegocios($1)`, [businessId]),
    ]);

    res.json({
      ok: true,
      business_id: businessId,
      stats: {
        total_articulos: articulosResult.rows[0]?.total || 0,
        total_insumos: insumosResult.rows[0]?.total || 0,
        total_subnegocios: subResult.rows.length,
      },
      subnegocios: subResult.rows,
    });
  } catch (e) {
    console.error('[divisions] getStatsWithSubnegocios', e);
    res.status(500).json({ ok: false, error: 'error_getting_stats' });
  }
};

// ============================================================================
// INSUMOS (LEGACY)
// ⚠️ Esto sigue moviendo insumos por business_id porque tu tabla insumos está así.
// Si después querés “insumos por división”, migramos a insumos.division_id.
// ============================================================================

exports.getInsumosStats = async (req, res) => {
  try {
    const businessId = num(req.params.businessId);
    if (!businessId) return res.status(400).json({ ok: false, error: 'invalid_business_id' });

    const result = await pool.query(
      `
      SELECT
        bd.id as division_id,
        bd.name as division_name,
        bd.is_main,
        COALESCE(COUNT(i.id),0)::integer as insumos_count
      FROM business_divisions bd
      LEFT JOIN insumos i ON i.business_id = bd.business_id
      WHERE bd.business_id = $1
      GROUP BY bd.id, bd.name, bd.is_main
      ORDER BY bd.is_main DESC, bd.name ASC
      `,
      [businessId]
    );

    res.json({ ok: true, business_id: businessId, detalle: result.rows });
  } catch (e) {
    console.error('[divisions] getInsumosStats', e);
    res.status(500).json({ ok: false, error: 'error_getting_insumos_stats' });
  }
};

exports.getInsumosByRubro = async (req, res) => {
  try {
    const businessId = num(req.params.businessId);
    if (!businessId) return res.status(400).json({ ok: false, error: 'invalid_business_id' });

    const result = await pool.query(
      `
      SELECT rubro, COUNT(id)::integer as count
      FROM insumos
      WHERE business_id = $1
        AND rubro IS NOT NULL AND rubro != ''
      GROUP BY rubro
      ORDER BY count DESC
      `,
      [businessId]
    );

    res.json({ ok: true, business_id: businessId, rubros: result.rows, total_rubros: result.rows.length });
  } catch (e) {
    console.error('[divisions] getInsumosByRubro', e);
    res.status(500).json({ ok: false, error: 'error_getting_insumos_by_rubro' });
  }
};

exports.moveInsumosToSubnegocio = async (_req, res) => {
  // ✅ Por ahora, si querés que sea por división, hay que migrar insumos.division_id.
  // Dejo un stub “honesto” para que no falle si lo llaman por accidente.
  return res.status(501).json({ ok: false, error: 'not_implemented', detail: 'insumos por division requiere insumos.division_id' });
};

exports.moveInsumosByRubroToSubnegocio = async (_req, res) => {
  return res.status(501).json({ ok: false, error: 'not_implemented', detail: 'insumos por division requiere insumos.division_id' });
};

// ============================================================================
// MOVER ARTÍCULOS A SUBNEGOCIOS (CORRECTO)
// ============================================================================

/**
 * POST /api/divisions/:divisionId/move-articles
 * Body: { articleIds: number[] }
 * ✅ Setea app_articles.division_id
 */
exports.moveArticlesToSubnegocio = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const divisionId = num(req.params.divisionId);
    const articleIds = Array.isArray(req.body?.articleIds) ? req.body.articleIds.map(num).filter(Boolean) : [];

    if (!divisionId) {
      await client.query('ROLLBACK');
      return res.status(400).json({ ok: false, error: 'invalid_division_id' });
    }
    if (!articleIds.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ ok: false, error: 'articleIds_required' });
    }

    // validar que la división existe
    const { rows: divRows } = await client.query(`SELECT id, business_id, name FROM business_divisions WHERE id=$1 LIMIT 1`, [divisionId]);
    if (!divRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'division_not_found' });
    }

    const { rows: updated } = await client.query(
      `
      UPDATE app_articles
         SET division_id = $1, updated_at = NOW()
       WHERE id = ANY($2::int[])
       RETURNING id
      `,
      [divisionId, articleIds]
    );

    await client.query('COMMIT');

    res.json({
      ok: true,
      division_id: divisionId,
      moved_count: updated.length,
    });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[divisions] moveArticlesToSubnegocio', e);
    res.status(500).json({ ok: false, error: 'internal_error', detail: e.message });
  } finally {
    client.release();
  }
};

// ============================================================================
// ENDPOINT PRINCIPAL: mover agrupación completa a división
// (ya lo tenías bastante bien; lo dejo como “fuente de verdad”)
// ============================================================================

/**
 * POST /api/divisions/move-agrupacion-complete
 * Body:
 * {
 *   agrupacionId: number,       // business_groups.id
 *   sourceBusinessId: number,   // business_groups.business_id
 *   targetDivisionId?: number,  // business_divisions.id (si no createNew)
 *   createNew?: boolean,
 *   newDivisionName?: string
 * }
 */
exports.moveAgrupacionComplete = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const agrupId = num(req.body?.agrupacionId);
    const sourceBizId = num(req.body?.sourceBusinessId);
    const createNew = !!req.body?.createNew;

    if (!agrupId || !sourceBizId) {
      await client.query('ROLLBACK');
      return res.status(400).json({ ok: false, error: 'agrupacionId y sourceBusinessId son requeridos' });
    }

    // Verificar grupo
    const { rows: groupRows } = await client.query(
      `SELECT id, business_id, name FROM business_groups WHERE id=$1 AND business_id=$2 LIMIT 1`,
      [agrupId, sourceBizId]
    );
    if (!groupRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'group_not_found' });
    }

    let targetDivision = null;

    if (createNew) {
      const name = String(req.body?.newDivisionName || '').trim();
      if (!name) {
        await client.query('ROLLBACK');
        return res.status(400).json({ ok: false, error: 'newDivisionName requerido si createNew=true' });
      }

      const code = await ensureUniqueCode(client, sourceBizId, name);

      const { rows: newDiv } = await client.query(
        `
        INSERT INTO business_divisions (business_id, name, code, is_main, is_active, source_group_id)
        VALUES ($1,$2,$3,false,true,$4)
        RETURNING *
        `,
        [sourceBizId, name, code, agrupId]
      );
      targetDivision = newDiv[0];
    } else {
      const targetDivisionId = num(req.body?.targetDivisionId);
      if (!targetDivisionId) {
        await client.query('ROLLBACK');
        return res.status(400).json({ ok: false, error: 'targetDivisionId requerido cuando createNew=false' });
      }

      const { rows: divRows } = await client.query(
        `SELECT * FROM business_divisions WHERE id=$1 AND business_id=$2 LIMIT 1`,
        [targetDivisionId, sourceBizId]
      );
      if (!divRows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ ok: false, error: 'target_division_not_found' });
      }
      targetDivision = divRows[0];
    }

    // Asignar el grupo a la división
    await client.query(
      `
      INSERT INTO division_group_assignments (division_id, group_id, is_customized)
      VALUES ($1,$2,false)
      ON CONFLICT (division_id, group_id) DO NOTHING
      `,
      [targetDivision.id, agrupId]
    );

    // Mover artículos: set division_id para los artículos del grupo
    const { rows: updatedArticles } = await client.query(
      `
      UPDATE app_articles
         SET division_id = $1, updated_at = NOW()
       WHERE id IN (SELECT article_id FROM article_groups WHERE group_id=$2)
       RETURNING id
      `,
      [targetDivision.id, agrupId]
    );

    // Alinear sales_daily_items (si corresponde)
    await client.query(
      `
      UPDATE sales_daily_items
         SET division_id = $1
       WHERE article_id IN (SELECT article_id FROM article_groups WHERE group_id=$2)
      `,
      [targetDivision.id, agrupId]
    );

    // Marcar el grupo como “movido” para que NO aparezca en principal
    await client.query(
      `UPDATE business_groups SET converted_to_division_id=$1 WHERE id=$2`,
      [targetDivision.id, agrupId]
    );

    await client.query('COMMIT');

    res.json({
      ok: true,
      created_new_division: createNew,
      target_division: { id: targetDivision.id, name: targetDivision.name, code: targetDivision.code },
      group: { id: agrupId, name: groupRows[0].name },
      articles_moved: updatedArticles.length,
    });

  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[divisions] moveAgrupacionComplete error:', e);
    res.status(500).json({ ok: false, error: 'internal_error', detail: e.message });
  } finally {
    client.release();
  }
};

// ============================================================================
// GRUPOS EN DIVISIONES
// ============================================================================

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
        COALESCE((SELECT COUNT(*) FROM article_groups ag WHERE ag.group_id = bg.id),0)::integer as article_count
      FROM division_group_assignments dga
      JOIN business_groups bg ON bg.id = dga.group_id
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

    await client.query(
      `
      INSERT INTO division_group_assignments (division_id, group_id, is_customized)
      VALUES ($1,$2,false)
      ON CONFLICT (division_id, group_id) DO NOTHING
      `,
      [divisionId, groupId]
    );

    // Opcional: set division_id a artículos del grupo
    const { rows: updated } = await client.query(
      `
      UPDATE app_articles
         SET division_id = $1, updated_at=NOW()
       WHERE id IN (SELECT article_id FROM article_groups WHERE group_id=$2)
       RETURNING id
      `,
      [divisionId, groupId]
    );

    await client.query('COMMIT');
    res.json({ ok: true, division_id: divisionId, group_id: groupId, articles_updated: updated.length });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[divisions] assignGroupToDivision error:', e);
    res.status(500).json({ ok: false, error: 'internal_error' });
  } finally {
    client.release();
  }
};

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

    await client.query(
      `DELETE FROM division_group_assignments WHERE division_id=$1 AND group_id=$2`,
      [divisionId, groupId]
    );

    // opcional: sacar division_id SOLO si coincide
    const { rows: updated } = await client.query(
      `
      UPDATE app_articles
         SET division_id = NULL, updated_at=NOW()
       WHERE division_id = $1
         AND id IN (SELECT article_id FROM article_groups WHERE group_id=$2)
       RETURNING id
      `,
      [divisionId, groupId]
    );

    // revertir “converted_to_division_id” si correspondía (opcional)
    await client.query(
      `UPDATE business_groups SET converted_to_division_id=NULL WHERE id=$1 AND converted_to_division_id=$2`,
      [groupId, divisionId]
    );

    await client.query('COMMIT');
    res.json({ ok: true, division_id: divisionId, group_id: groupId, articles_updated: updated.length });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[divisions] removeGroupFromDivision error:', e);
    res.status(500).json({ ok: false, error: 'internal_error' });
  } finally {
    client.release();
  }
};

// ============================================================================
// EXPORT
// ============================================================================

module.exports = {
  getDivisionsByBusiness: exports.getDivisionsByBusiness,
  getMainDivision: exports.getMainDivision,
  getDivisionById: exports.getDivisionById,
  createDivision: exports.createDivision,
  updateDivision: exports.updateDivision,
  deleteDivision: exports.deleteDivision,

  getBusinessHierarchy: exports.getBusinessHierarchy,
  getAllSubnegocios: exports.getAllSubnegocios,
  getStatsWithSubnegocios: exports.getStatsWithSubnegocios,

  getInsumosStats: exports.getInsumosStats,
  getInsumosByRubro: exports.getInsumosByRubro,
  moveInsumosToSubnegocio: exports.moveInsumosToSubnegocio,
  moveInsumosByRubroToSubnegocio: exports.moveInsumosByRubroToSubnegocio,

  moveArticlesToSubnegocio: exports.moveArticlesToSubnegocio,

  moveAgrupacionComplete: exports.moveAgrupacionComplete,
  getGroupsByDivision: exports.getGroupsByDivision,
  assignGroupToDivision: exports.assignGroupToDivision,
  removeGroupFromDivision: exports.removeGroupFromDivision,
};
