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
      await client.query('ROLLBACK');
      const alreadyLinked = existing.map(r => Number(r.article_id));
      return res.status(409).json({
        ok: false,
        error: `${existing.length} artículo(s) ya están vinculados`,
        alreadyLinked,
      });
    }

    // Crear el grupo
    const { rows: groupRows } = await client.query(
      `INSERT INTO article_link_groups (business_id, name)
       VALUES ($1, $2)
       RETURNING id, name, sync_recipe, sync_objetivo, sync_precio`,
      [bizId, name]
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
// ============================================================================
exports.deleteLinkGroup = async (req, res) => {
  try {
    const bizId = getBusinessId(req);
    const groupId = safeNum(req.params.groupId);

    if (!Number.isFinite(bizId) || !groupId) {
      return res.status(400).json({ ok: false, error: 'parámetros inválidos' });
    }

    const { rowCount } = await pool.query(
      `DELETE FROM article_link_groups WHERE id = $1 AND business_id = $2`,
      [groupId, bizId]
    );

    if (!rowCount) {
      return res.status(404).json({ ok: false, error: 'Grupo de vinculación no encontrado' });
    }

    // Los miembros se eliminan por CASCADE en la FK
    return res.json({ ok: true });
  } catch (e) {
    console.error('[deleteLinkGroup]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

// ============================================================================
// DELETE /businesses/:id/article-links/:groupId/members/:articleId
// Saca un artículo de la vinculación sin eliminar el grupo.
// Si quedan menos de 2 miembros, elimina el grupo completo.
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

    // Verificar que el grupo pertenezca al negocio
    const { rows: groupRows } = await client.query(
      `SELECT id FROM article_link_groups WHERE id = $1 AND business_id = $2`,
      [groupId, bizId]
    );
    if (!groupRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'Grupo no encontrado' });
    }

    // Eliminar el miembro
    await client.query(
      `DELETE FROM article_link_members
       WHERE link_group_id = $1 AND article_id = $2 AND business_id = $3`,
      [groupId, articleId, bizId]
    );

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

    return res.json({ ok: true, groupDeleted, remainingMembers: remaining });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[removeMember]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  } finally {
    client.release();
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
// Útil para el frontend al renderizar el ícono de cadena.
// ============================================================================
exports.getLinkByArticle = async (req, res) => {
  try {
    const bizId = getBusinessId(req);
    const articleId = safeNum(req.params.articleId);

    if (!Number.isFinite(bizId) || !articleId) {
      return res.status(400).json({ ok: false, error: 'parámetros inválidos' });
    }

    const { rows } = await pool.query(
      `SELECT
         g.id AS group_id,
         g.name AS group_name,
         g.sync_recipe,
         g.sync_objetivo,
         g.sync_precio,
         array_agg(m2.article_id ORDER BY m2.joined_at) AS member_ids
       FROM article_link_members m
       JOIN article_link_groups g ON g.id = m.link_group_id
       JOIN article_link_members m2 ON m2.link_group_id = g.id
       WHERE m.article_id = $1 AND m.business_id = $2
       GROUP BY g.id`,
      [articleId, bizId]
    );

    if (!rows.length) {
      return res.json({ ok: true, group: null });
    }

    return res.json({ ok: true, group: rows[0] });
  } catch (e) {
    console.error('[getLinkByArticle]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

// POST /businesses/:id/article-links/:groupId/members
// Body: { articleId: number }
// Agrega un artículo a un grupo existente
exports.addMember = async (req, res) => {
  const bizId = getBusinessId(req);
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