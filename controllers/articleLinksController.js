// controllers/articleLinksController.js
const pool = require('../config/db');

/* ========================= Helpers ========================= */

const safeNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function getBusinessId(req) {
  const ctx = Number(req.businessId);
  if (Number.isFinite(ctx)) return ctx;
  const p = Number(req.params?.businessId ?? req.params?.id);
  if (Number.isFinite(p)) return p;
  const h = Number(req.header('X-Business-Id'));
  if (Number.isFinite(h)) return h;
  return NaN;
}

/* ========================= GRUPOS DE VINCULACIÓN ========================= */

// ============================================================================
// GET /businesses/:id/article-links
// Devuelve todos los grupos de vinculación del negocio con sus miembros.
// ============================================================================
exports.getLinkGroups = async (req, res) => {
  try {
    const bizId = getBusinessId(req);
    if (!Number.isFinite(bizId)) {
      return res.status(400).json({ ok: false, error: 'businessId inválido' });
    }

    const { rows: groups } = await pool.query(
      `SELECT id, name, sync_recipe, sync_objetivo, sync_precio, created_at
       FROM article_link_groups
       WHERE business_id = $1
       ORDER BY created_at DESC`,
      [bizId]
    );

    if (!groups.length) return res.json({ ok: true, groups: [] });

    const groupIds = groups.map(g => g.id);

    const { rows: members } = await pool.query(
      `SELECT link_group_id, article_id
       FROM article_link_members
       WHERE link_group_id = ANY($1::bigint[])
       ORDER BY joined_at ASC`,
      [groupIds]
    );

    // Mapear miembros a sus grupos
    const membersByGroup = {};
    for (const m of members) {
      const gid = Number(m.link_group_id);
      if (!membersByGroup[gid]) membersByGroup[gid] = [];
      membersByGroup[gid].push({ article_id: Number(m.article_id) });
    }

    const result = groups.map(g => ({
      ...g,
      members: membersByGroup[Number(g.id)] || [],
    }));

    return res.json({ ok: true, groups: result });
  } catch (e) {
    console.error('[getLinkGroups]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

// ============================================================================
// POST /businesses/:id/article-links
// Body: { articleIds: number[], name?: string }
// Crea un grupo de vinculación. Falla si algún artículo ya está vinculado.
// ============================================================================
exports.createLinkGroup = async (req, res) => {
  const bizId = getBusinessId(req);
  const articleIds = (Array.isArray(req.body?.articleIds) ? req.body.articleIds : [])
    .map(Number).filter(Number.isFinite);
  const name = String(req.body?.name ?? '').trim() || null;
  const syncRecipe = req.body?.syncRecipe === true;
  const syncObjetivo = req.body?.syncObjetivo === true;
  const syncPrecio = req.body?.syncPrecio !== false; // default true (compatibilidad)

  if (!Number.isFinite(bizId) || articleIds.length < 2) {
    return res.status(400).json({ ok: false, error: 'Se necesitan al menos 2 artículos para vincular' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Verificar que ninguno ya esté vinculado en este negocio
    const { rows: existing } = await client.query(
      `SELECT article_id FROM article_link_members
       WHERE article_id = ANY($1::bigint[]) AND business_id = $2`,
      [articleIds, bizId]
    );

    if (existing.length) {
      // Alguno ya está vinculado — buscar el grupo existente y agregar los demás
      const existingId = Number(existing[0].article_id);
      const { rows: groupData } = await client.query(
        `SELECT g.id AS group_id, g.name AS group_name, g.sync_recipe, g.sync_objetivo, g.sync_precio
           FROM article_link_members m
           JOIN article_link_groups g ON g.id = m.link_group_id
          WHERE m.article_id = $1 AND m.business_id = $2 LIMIT 1`,
        [existingId, bizId]
      );
      await client.query('ROLLBACK');
      if (groupData.length) {
        return res.status(409).json({
          ok: false,
          error: `Artículo ya vinculado`,
          alreadyLinked: existing.map(r => Number(r.article_id)),
          existingGroup: { groupId: groupData[0].group_id, groupName: groupData[0].group_name },
        });
      }
      return res.status(409).json({
        ok: false,
        error: `${existing.length} artículo(s) ya están vinculados`,
        alreadyLinked: existing.map(r => Number(r.article_id)),
      });
    }

    // Crear el grupo
    const { rows: groupRows } = await client.query(
      `INSERT INTO article_link_groups (business_id, name, sync_recipe, sync_objetivo, sync_precio)
   VALUES ($1, $2, $3, $4, $5)
   RETURNING id, name, sync_recipe, sync_objetivo, sync_precio`,
      [bizId, name, syncRecipe, syncObjetivo, syncPrecio]
    );
    const group = groupRows[0];
    const groupId = Number(group.id);

    // Insertar miembros
    const memberValues = articleIds.map((_, i) => `($1, $${i + 2}, $${articleIds.length + 2})`).join(', ');
    await client.query(
      `INSERT INTO article_link_members (link_group_id, article_id, business_id)
       VALUES ${memberValues}`,
      [groupId, ...articleIds, bizId]
    );

    await client.query('COMMIT');

    return res.status(201).json({
      ok: true,
      group: {
        ...group,
        members: articleIds.map(id => ({ article_id: id })),
      },
    });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[createLinkGroup]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  } finally {
    client.release();
  }
};

// ============================================================================
// DELETE /businesses/:id/article-links/:groupId
// Elimina el grupo completo — todos los artículos quedan independientes.
// Si era de receta, todos los artículos quedan también sin receta.
// ============================================================================
exports.deleteLinkGroup = async (req, res) => {
  const client = await pool.connect();
  try {
    const bizId = getBusinessId(req);
    const groupId = safeNum(req.params.groupId);

    if (!Number.isFinite(bizId) || !groupId) {
      return res.status(400).json({ ok: false, error: 'parámetros inválidos' });
    }

    await client.query('BEGIN');

    // Leer el grupo y sus miembros antes de borrar
    const { rows: groupRows } = await client.query(
      `SELECT sync_recipe FROM article_link_groups
        WHERE id = $1 AND business_id = $2`,
      [groupId, bizId]
    );
    if (!groupRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'Grupo de vinculación no encontrado' });
    }
    const isRecipeLink = groupRows[0].sync_recipe === true;

    let memberIds = [];
    if (isRecipeLink) {
      const { rows: m } = await client.query(
        `SELECT article_id FROM article_link_members WHERE link_group_id = $1`,
        [groupId]
      );
      memberIds = m.map(r => Number(r.article_id)).filter(Number.isFinite);
    }

    // Borrar el grupo (CASCADE elimina los miembros)
    const { rowCount } = await client.query(
      `DELETE FROM article_link_groups WHERE id = $1 AND business_id = $2`,
      [groupId, bizId]
    );

    if (!rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'Grupo de vinculación no encontrado' });
    }

    // Si era de receta, desactivar las recetas de todos los miembros
    let recipesDeleted = 0;
    if (isRecipeLink && memberIds.length) {
      const { rowCount: r } = await client.query(
        `UPDATE recetas
            SET active = FALSE, updated_at = NOW()
          WHERE article_id = ANY($1::bigint[]) AND business_id = $2 AND active = TRUE`,
        [memberIds, bizId]
      );
      recipesDeleted = r || 0;
      await client.query(
        `UPDATE insumos
            SET costo_receta = 0, tiene_receta = FALSE, updated_at = NOW()
          WHERE id = ANY($1::bigint[]) AND business_id = $2
            AND (es_elaborado = TRUE OR es_elaborado_manual = TRUE)`,
        [memberIds, bizId]
      );
    }

    await client.query('COMMIT');
    return res.json({ ok: true, recipesDeleted, affectedArticles: memberIds });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { }
    console.error('[deleteLinkGroup]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  } finally {
    client.release();
  }
};

// ============================================================================
// DELETE /businesses/:id/article-links/:groupId/members/:articleId
// Saca un artículo de la vinculación sin eliminar el grupo.
// Si quedan menos de 2 miembros, elimina el grupo completo.
// Si el grupo era de receta (sync_recipe=true), borra también la receta del
// artículo desvinculado — pierde sentido sin la vinculación.
// ============================================================================
exports.removeMember = async (req, res) => {
  const bizId = getBusinessId(req);
  const groupId = safeNum(req.params.groupId);
  const articleId = safeNum(req.params.articleId);

  if (!Number.isFinite(bizId) || !groupId || !articleId) {
    return res.status(400).json({ ok: false, error: 'parámetros inválidos' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Verificar que el grupo pertenezca al negocio y obtener el tipo de sync
    const { rows: groupRows } = await client.query(
      `SELECT id, sync_recipe FROM article_link_groups
        WHERE id = $1 AND business_id = $2`,
      [groupId, bizId]
    );
    if (!groupRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'Grupo no encontrado' });
    }
    const isRecipeLink = groupRows[0].sync_recipe === true;

    // Eliminar el miembro
    await client.query(
      `DELETE FROM article_link_members
        WHERE link_group_id = $1 AND article_id = $2 AND business_id = $3`,
      [groupId, articleId, bizId]
    );

    // Si era vinculación de receta, borrar la receta del artículo desvinculado.
    // El artículo queda limpio — sin receta y sin link.
    let recipeDeleted = false;
    if (isRecipeLink) {
      const { rowCount: recDel } = await client.query(
        `UPDATE recetas
            SET active = FALSE, updated_at = NOW()
          WHERE article_id = $1 AND business_id = $2 AND active = TRUE`,
        [articleId, bizId]
      );
      recipeDeleted = recDel > 0;
      // Limpiar también los flags de elaborados (por si el artículo era usado como insumo)
      await client.query(
        `UPDATE insumos
            SET costo_receta = 0, tiene_receta = FALSE, updated_at = NOW()
          WHERE id = $1 AND business_id = $2
            AND (es_elaborado = TRUE OR es_elaborado_manual = TRUE)`,
        [articleId, bizId]
      );
    }

    // Contar miembros restantes
    const { rows: countRows } = await client.query(
      `SELECT COUNT(*)::int AS cnt FROM article_link_members WHERE link_group_id = $1`,
      [groupId]
    );
    const remaining = countRows[0]?.cnt ?? 0;

    let groupDeleted = false;
    if (remaining < 2) {
      // Con menos de 2 miembros no tiene sentido mantener la vinculación
      await client.query(
        `DELETE FROM article_link_groups WHERE id = $1`,
        [groupId]
      );
      groupDeleted = true;
    }

    await client.query('COMMIT');

    return res.json({
      ok: true,
      groupDeleted,
      remainingMembers: remaining,
      recipeDeleted,
    });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[removeMember]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  } finally {
    client.release();
  }
};

// PATCH /businesses/:id/article-links/:groupId/members/:articleId
// Body: { pct_objetivo: number | null }
exports.updateMember = async (req, res) => {
  const bizId = getBusinessId(req);
  const groupId = Number(req.params.groupId);
  const articleId = Number(req.params.articleId);
  const { pct_objetivo } = req.body || {};

  if (!Number.isFinite(bizId) || !Number.isFinite(groupId) || !Number.isFinite(articleId)) {
    return res.status(400).json({ ok: false, error: 'Parámetros inválidos' });
  }

  try {
    const val = pct_objetivo != null && Number.isFinite(Number(pct_objetivo))
      ? Number(pct_objetivo)
      : null;

    const { rowCount } = await pool.query(
      `UPDATE article_link_members
          SET pct_objetivo = $1
        WHERE link_group_id = $2 AND article_id = $3 AND business_id = $4`,
      [val, groupId, articleId, bizId]
    );

    if (!rowCount) {
      return res.status(404).json({ ok: false, error: 'Miembro no encontrado' });
    }

    return res.json({ ok: true, article_id: articleId, pct_objetivo: val });
  } catch (e) {
    console.error('[updateMember]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

/* ========================= PROPAGACIÓN ========================= */

// ============================================================================
// POST /businesses/:id/article-links/:groupId/propagate
// Body: { triggeredBy: number, changeType: 'recipe'|'objetivo'|'precio_manual', changeDetail: {} }
// El backend lo llama internamente cuando guarda receta/precio/objetivo
// de un artículo vinculado. También puede llamarse desde el front si hace falta.
// Devuelve los IDs de artículos afectados para que el front propague el cambio.
// ============================================================================
exports.propagateChange = async (req, res) => {
  const bizId = getBusinessId(req);
  const groupId = safeNum(req.params.groupId);
  const triggeredBy = safeNum(req.body?.triggeredBy);
  const changeType = String(req.body?.changeType ?? '');
  const changeDetail = req.body?.changeDetail ?? {};

  const validTypes = ['recipe', 'objetivo', 'precio_manual'];
  if (!Number.isFinite(bizId) || !groupId || !triggeredBy || !validTypes.includes(changeType)) {
    return res.status(400).json({ ok: false, error: 'parámetros inválidos' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Obtener todos los miembros del grupo
    const { rows: members } = await client.query(
      `SELECT article_id FROM article_link_members
       WHERE link_group_id = $1 AND business_id = $2`,
      [groupId, bizId]
    );

    const propagatedTo = members
      .map(m => Number(m.article_id))
      .filter(id => id !== triggeredBy);

    if (!propagatedTo.length) {
      await client.query('COMMIT');
      return res.json({ ok: true, propagatedTo: [], count: 0 });
    }

    // Registrar la propagación en el log
    await client.query(
      `INSERT INTO article_link_propagations
         (link_group_id, business_id, triggered_by, propagated_to, change_type, change_detail)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [groupId, bizId, triggeredBy, propagatedTo, changeType, JSON.stringify(changeDetail)]
    );

    await client.query('COMMIT');

    return res.json({
      ok: true,
      propagatedTo,
      count: propagatedTo.length,
      changeType,
      changeDetail,
    });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[propagateChange]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  } finally {
    client.release();
  }
};

// ============================================================================
// GET /businesses/:id/article-links/propagations
// Query: ?limit=20
// Historial de propagaciones para el panel de notificaciones.
// ============================================================================
exports.getPropagations = async (req, res) => {
  try {
    const bizId = getBusinessId(req);
    if (!Number.isFinite(bizId)) {
      return res.status(400).json({ ok: false, error: 'businessId inválido' });
    }

    const limit = Math.min(Math.max(safeNum(req.query.limit) ?? 20, 1), 100);

    const { rows } = await pool.query(
      `SELECT
         p.id,
         p.link_group_id,
         g.name AS group_name,
         p.triggered_by,
         p.propagated_to,
         p.change_type,
         p.change_detail,
         p.created_at,
         array_length(p.propagated_to, 1) AS affected_count
       FROM article_link_propagations p
       LEFT JOIN article_link_groups g ON g.id = p.link_group_id
       WHERE p.business_id = $1
       ORDER BY p.created_at DESC
       LIMIT $2`,
      [bizId, limit]
    );

    return res.json({ ok: true, propagations: rows });
  } catch (e) {
    console.error('[getPropagations]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

// ============================================================================
// GET /businesses/:id/article-links/by-article/:articleId
// Devuelve el grupo de vinculación de un artículo específico (si existe).
// Incluye nombre y pct_objetivo de cada miembro para el panel de gemelos.
// ============================================================================
exports.getLinkByArticle = async (req, res) => {
  try {
    const bizId = getBusinessId(req);
    const articleId = safeNum(req.params.articleId);

    if (!Number.isFinite(bizId) || !articleId) {
      return res.status(400).json({ ok: false, error: 'parámetros inválidos' });
    }

    // Buscar el grupo del artículo
    const { rows: groupRows } = await pool.query(
      `SELECT g.id AS group_id, g.name AS group_name, g.sync_recipe, g.sync_objetivo, g.sync_precio
         FROM article_link_members m
         JOIN article_link_groups g ON g.id = m.link_group_id
        WHERE m.article_id = $1 AND m.business_id = $2
        LIMIT 1`,
      [articleId, bizId]
    );

    if (!groupRows.length) {
      return res.json({ ok: true, group: null });
    }

    const group = groupRows[0];

    // Obtener todos los miembros con nombre y pct_objetivo
    const { rows: memberRows } = await pool.query(
      `SELECT
     m.article_id,
     COALESCE(apc.objetivo_pct, m.pct_objetivo) AS pct_objetivo,
     COALESCE(ma.nombre, aa.name, '#' || m.article_id::text) AS nombre
   FROM article_link_members m
   LEFT JOIN maxi_articles ma ON ma.business_id = $2 AND ma.articulo_id = m.article_id
   LEFT JOIN app_articles aa ON aa.business_id = $2 AND aa.id = m.article_id
   LEFT JOIN article_price_config apc
     ON apc.business_id = $2
    AND apc.scope = 'articulo'
    AND apc.scope_id = m.article_id::text
  WHERE m.link_group_id = $1
  ORDER BY m.joined_at`,
      [group.group_id, bizId]
    );

    return res.json({
      ok: true,
      group: {
        groupId: group.group_id,
        groupName: group.group_name,
        syncRecipe: group.sync_recipe,
        syncObjetivo: group.sync_objetivo,
        syncPrecio: group.sync_precio,
        members: memberRows.map(m => ({
          article_id: Number(m.article_id),
          nombre: m.nombre,
          pct_objetivo: m.pct_objetivo != null ? Number(m.pct_objetivo) : null,
        })),
      },
    });
  } catch (e) {
    console.error('[getLinkByArticle]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

// POST /businesses/:id/article-links/:groupId/members
// Body: { articleId: number }
// Agrega un artículo a un grupo existente
exports.addMember = async (req, res) => {
  console.log('[addMember] params:', req.params, 'body:', req.body);
  const bizId = getBusinessId(req);
  console.log('[addMember] bizId:', bizId);
  const groupId = Number(req.params.groupId);
  const articleId = Number(req.body?.articleId);

  if (!Number.isFinite(bizId) || !Number.isFinite(groupId) || !Number.isFinite(articleId)) {
    return res.status(400).json({ ok: false, error: 'Parámetros inválidos' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Verificar que el grupo pertenece al negocio
    const { rows: groupRows } = await client.query(
      `SELECT id FROM article_link_groups WHERE id = $1 AND business_id = $2`,
      [groupId, bizId]
    );
    if (!groupRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'Grupo no encontrado' });
    }

    // Verificar que el artículo no esté ya en otro grupo
    const { rows: existing } = await client.query(
      `SELECT link_group_id FROM article_link_members WHERE article_id = $1 AND business_id = $2`,
      [articleId, bizId]
    );
    if (existing.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        ok: false,
        error: 'El artículo ya está vinculado a otro grupo',
        existingGroupId: Number(existing[0].link_group_id),
      });
    }

    // Agregar el miembro
    await client.query(
      `INSERT INTO article_link_members (link_group_id, article_id, business_id)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [groupId, articleId, bizId]
    );

    await client.query('COMMIT');
    return res.json({ ok: true, groupId, articleId });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { }
    console.error('[addMember]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  } finally {
    client.release();
  }
};