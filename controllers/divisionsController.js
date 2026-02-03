/**
 * Controller de divisiones (subnegocios) - MODELO DE FILTROS
 * ✅ Las divisiones solo definen QUÉ GRUPOS mostrar
 * ✅ Los artículos permanecen en el negocio principal
 * ✅ Los insumos permanecen en el negocio principal
 * ✅ Las ventas se guardan con business_id del principal
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

    res.json({ ok: true, business_id: businessId, divisions: rows });
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
// GESTIÓN DE GRUPOS EN DIVISIONES
// ============================================================================

/**
 * GET /api/divisions/:divisionId/groups
 * Obtiene grupos asignados a una división
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

/**
 * POST /api/divisions/:divisionId/assign-group
 * Body soportado:
 *  - { groupId: number }   (camelCase)
 *  - { group_id: number }  (snake_case)
 *
 * Asigna un grupo a una división (solo crea la relación, NO mueve datos)
 */
exports.assignGroupToDivision = async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const divisionId = num(req.params.divisionId);

    // ✅ Soporta ambos formatos
    const rawGroupId = req.body?.groupId ?? req.body?.group_id;
    const groupId = num(rawGroupId);

    if (!divisionId || !groupId) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        ok: false,
        error: 'division_id y group_id requeridos',
        details: {
          divisionId: req.params.divisionId ?? null,
          groupId: rawGroupId ?? null,
        },
      });
    }

    // Verificar que la división existe
    const { rows: divRows } = await client.query(
      `SELECT id, business_id FROM business_divisions WHERE id=$1`,
      [divisionId]
    );
    if (!divRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'division_not_found' });
    }

    // Verificar que el grupo existe y pertenece al mismo negocio
    const { rows: groupRows } = await client.query(
      `SELECT id, business_id FROM business_groups WHERE id=$1`,
      [groupId]
    );
    if (!groupRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'group_not_found' });
    }

    if (Number(groupRows[0].business_id) !== Number(divRows[0].business_id)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ ok: false, error: 'group_business_mismatch' });
    }

    // Crear la asignación (solo la relación, no movemos datos)
    await client.query(
      `
      INSERT INTO division_group_assignments (division_id, group_id, is_customized)
      VALUES ($1, $2, false)
      ON CONFLICT (division_id, group_id) DO NOTHING
      `,
      [divisionId, groupId]
    );

    await client.query('COMMIT');
    return res.json({ ok: true, division_id: divisionId, group_id: groupId });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[divisions] assignGroupToDivision error:', e);
    return res.status(500).json({ ok: false, error: 'internal_error' });
  } finally {
    client.release();
  }
};

/**
 * DELETE /api/divisions/:divisionId/groups/:groupId
 * Remueve la asignación de un grupo a una división
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

    await client.query(
      `DELETE FROM division_group_assignments WHERE division_id=$1 AND group_id=$2`,
      [divisionId, groupId]
    );

    await client.query('COMMIT');
    res.json({ ok: true, division_id: divisionId, group_id: groupId });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[divisions] removeGroupFromDivision error:', e);
    res.status(500).json({ ok: false, error: 'internal_error' });
  } finally {
    client.release();
  }
};

/**
 * POST /api/divisions/create-from-group
 * Body: { businessId, groupId, name? }
 * Crea una división nueva y le asigna un grupo específico
 */
exports.createDivisionFromGroup = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const businessId = num(req.body?.businessId);
    const groupId = num(req.body?.groupId);
    let name = req.body?.name ? String(req.body.name).trim() : null;

    if (!businessId || !groupId) {
      await client.query('ROLLBACK');
      return res.status(400).json({ ok: false, error: 'businessId y groupId requeridos' });
    }

    // Obtener info del grupo
    const { rows: groupRows } = await client.query(
      `SELECT id, name, business_id FROM business_groups WHERE id=$1`,
      [groupId]
    );
    if (!groupRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'group_not_found' });
    }

    if (groupRows[0].business_id !== businessId) {
      await client.query('ROLLBACK');
      return res.status(400).json({ ok: false, error: 'group_business_mismatch' });
    }

    // Si no viene nombre, usar el del grupo
    if (!name) {
      name = groupRows[0].name;
    }

    const code = await ensureUniqueCode(client, businessId, name);

    // Crear la división
    const { rows: divRows } = await client.query(
      `
      INSERT INTO business_divisions (business_id, name, code, is_main, is_active, source_group_id)
      VALUES ($1, $2, $3, false, true, $4)
      RETURNING *
      `,
      [businessId, name, code, groupId]
    );

    const newDivision = divRows[0];

    // Asignar el grupo a la nueva división
    await client.query(
      `
      INSERT INTO division_group_assignments (division_id, group_id, is_customized)
      VALUES ($1, $2, false)
      `,
      [newDivision.id, groupId]
    );

    await client.query('COMMIT');
    res.status(201).json({
      ok: true,
      division: newDivision,
      group: { id: groupId, name: groupRows[0].name }
    });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[divisions] createDivisionFromGroup error:', e);
    res.status(500).json({ ok: false, error: 'internal_error' });
  } finally {
    client.release();
  }
};

// ============================================================================
// OBTENER ARTÍCULOS DE UNA DIVISIÓN (FILTRADOS)
// ============================================================================

/**
 * GET /api/divisions/:divisionId/articles
 * Devuelve artículos que están en los grupos asignados a esta división
 */
exports.getArticlesByDivision = async (req, res) => {
  try {
    const divisionId = num(req.params.divisionId);
    if (!divisionId) return res.status(400).json({ ok: false, error: 'invalid_division_id' });

    // 1. Obtener grupos asignados
    const { rows: assignments } = await pool.query(
      `SELECT group_id FROM division_group_assignments WHERE division_id = $1`,
      [divisionId]
    );

    const groupIds = assignments.map(a => a.group_id);

    if (groupIds.length === 0) {
      return res.json({ ok: true, division_id: divisionId, articles: [] });
    }

    // 2. Traer artículos de esos grupos
    const { rows: articles } = await pool.query(
      `
      SELECT DISTINCT
        a.id,
        a.name,
        a.codigo_menu,
        a.business_id,
        a.tipo,
        a.precio_venta,
        a.activo,
        json_agg(DISTINCT jsonb_build_object(
          'id', bg.id,
          'name', bg.name
        )) FILTER (WHERE bg.id IS NOT NULL) as grupos
      FROM app_articles a
      INNER JOIN article_groups ag ON ag.article_id = a.id
      INNER JOIN business_groups bg ON bg.id = ag.group_id
      WHERE bg.id = ANY($1::int[])
      GROUP BY a.id
      ORDER BY a.name
      `,
      [groupIds]
    );

    res.json({
      ok: true,
      division_id: divisionId,
      article_count: articles.length,
      articles
    });
  } catch (e) {
    console.error('[divisions] getArticlesByDivision error:', e);
    res.status(500).json({ ok: false, error: 'internal_error' });
  }
};

/**
 * GET /api/divisions/:divisionId/stats
 * Estadísticas de una división (artículos, grupos)
 */
exports.getDivisionStats = async (req, res) => {
  try {
    const divisionId = num(req.params.divisionId);
    if (!divisionId) return res.status(400).json({ ok: false, error: 'invalid_division_id' });

    // Grupos asignados
    const { rows: groups } = await pool.query(
      `SELECT group_id FROM division_group_assignments WHERE division_id = $1`,
      [divisionId]
    );

    const groupIds = groups.map(g => g.group_id);
    let articleCount = 0;

    if (groupIds.length > 0) {
      const { rows } = await pool.query(
        `
        SELECT COUNT(DISTINCT article_id)::integer as count
        FROM article_groups
        WHERE group_id = ANY($1::int[])
        `,
        [groupIds]
      );
      articleCount = rows[0]?.count || 0;
    }

    res.json({
      ok: true,
      division_id: divisionId,
      stats: {
        assigned_groups: groupIds.length,
        total_articles: articleCount
      }
    });
  } catch (e) {
    console.error('[divisions] getDivisionStats error:', e);
    res.status(500).json({ ok: false, error: 'internal_error' });
  }
};

async function moveAgrupacionComplete(req, res) {
  try {
    const divisionIdRaw = req.body.divisionId;
    const groupId = Number(req.body.groupId);

    const divisionId =
      divisionIdRaw === null || divisionIdRaw === undefined || divisionIdRaw === ''
        ? null
        : Number(divisionIdRaw);

    if (!Number.isFinite(groupId) || groupId <= 0) {
      return res.status(400).json({ ok: false, error: 'groupId inválido' });
    }

    // Si vuelve al "Principal" => quitamos asignación
    if (divisionId === null) {
      await pool.query(
        `DELETE FROM division_group_assignments
         WHERE group_id = $1`,
        [groupId]
      );

      return res.json({ ok: true, assigned: false, groupId });
    }

    if (!Number.isFinite(divisionId) || divisionId <= 0) {
      return res.status(400).json({ ok: false, error: 'divisionId inválido' });
    }

    // Asignar (si ya existía en otra división, se reemplaza)
    await pool.query(
      `INSERT INTO division_group_assignments (division_id, group_id)
       VALUES ($1, $2)
       ON CONFLICT (group_id)
       DO UPDATE SET division_id = EXCLUDED.division_id`,
      [divisionId, groupId]
    );

    return res.json({ ok: true, assigned: true, divisionId, groupId });
  } catch (e) {
    console.error('moveAgrupacionComplete error', e);
    res.status(500).json({ ok: false, error: e.message });
  }
}

// ============================================================================
// EXPORT
// ============================================================================

module.exports = {
  // CRUD divisiones
  getDivisionsByBusiness: exports.getDivisionsByBusiness,
  getMainDivision: exports.getMainDivision,
  getDivisionById: exports.getDivisionById,
  createDivision: exports.createDivision,
  updateDivision: exports.updateDivision,
  deleteDivision: exports.deleteDivision,
   moveAgrupacionComplete,

  // Grupos en divisiones
  getGroupsByDivision: exports.getGroupsByDivision,
  assignGroupToDivision: exports.assignGroupToDivision,
  removeGroupFromDivision: exports.removeGroupFromDivision,
  createDivisionFromGroup: exports.createDivisionFromGroup,

  // Artículos filtrados
  getArticlesByDivision: exports.getArticlesByDivision,
  getDivisionStats: exports.getDivisionStats,
};