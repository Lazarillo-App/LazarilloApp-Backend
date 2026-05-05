// controllers/articleListsController.js
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

/* ========================= LISTAS ========================= */

// ============================================================================
// GET /businesses/:id/article-lists
// Devuelve todas las listas del negocio con cantidad de artículos.
// ============================================================================
exports.getLists = async (req, res) => {
  try {
    const bizId = getBusinessId(req);
    if (!Number.isFinite(bizId)) {
      return res.status(400).json({ ok: false, error: 'businessId inválido' });
    }

    const { rows } = await pool.query(
      `SELECT
         l.id,
         l.name,
         l.description,
         l.color,
         l.created_at,
         l.updated_at,
         COUNT(li.id)::int AS item_count
       FROM article_lists l
       LEFT JOIN article_list_items li ON li.list_id = l.id
       WHERE l.business_id = $1
       GROUP BY l.id
       ORDER BY l.created_at DESC`,
      [bizId]
    );

    return res.json({ ok: true, lists: rows });
  } catch (e) {
    console.error('[getLists]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

// ============================================================================
// POST /businesses/:id/article-lists
// Body: { name: string, description?: string, color?: string }
// ============================================================================
exports.createList = async (req, res) => {
  try {
    const bizId = getBusinessId(req);
    if (!Number.isFinite(bizId)) {
      return res.status(400).json({ ok: false, error: 'businessId inválido' });
    }

    const name = String(req.body?.name ?? '').trim();
    const description = String(req.body?.description ?? '').trim() || null;
    const color = String(req.body?.color ?? '').trim() || null;

    if (!name) {
      return res.status(400).json({ ok: false, error: 'El nombre es obligatorio' });
    }

    const { rows } = await pool.query(
      `INSERT INTO article_lists (business_id, name, description, color)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, description, color, created_at`,
      [bizId, name, description, color]
    );

    return res.status(201).json({ ok: true, list: rows[0] });
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ ok: false, error: 'Ya existe una lista con ese nombre' });
    }
    console.error('[createList]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

// ============================================================================
// PUT /businesses/:id/article-lists/:listId
// Body: { name?, description?, color? }
// ============================================================================
exports.updateList = async (req, res) => {
  try {
    const bizId = getBusinessId(req);
    const listId = safeNum(req.params.listId);

    if (!Number.isFinite(bizId) || !listId) {
      return res.status(400).json({ ok: false, error: 'parámetros inválidos' });
    }

    const sets = [];
    const vals = [];
    const push = (col, val) => { vals.push(val); sets.push(`${col} = $${vals.length}`); };

    if (req.body?.name !== undefined) {
      const name = String(req.body.name ?? '').trim();
      if (!name) return res.status(400).json({ ok: false, error: 'El nombre no puede quedar vacío' });
      push('name', name);
    }
    if (req.body?.description !== undefined) push('description', req.body.description || null);
    if (req.body?.color !== undefined) push('color', req.body.color || null);

    if (!sets.length) return res.json({ ok: true });

    const sql = `
      UPDATE article_lists
         SET ${sets.join(', ')}, updated_at = NOW()
       WHERE id = $${vals.length + 1} AND business_id = $${vals.length + 2}
       RETURNING id, name, description, color, updated_at`;

    const { rows } = await pool.query(sql, [...vals, listId, bizId]);

    if (!rows.length) {
      return res.status(404).json({ ok: false, error: 'Lista no encontrada' });
    }

    return res.json({ ok: true, list: rows[0] });
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ ok: false, error: 'Ya existe una lista con ese nombre' });
    }
    console.error('[updateList]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

// ============================================================================
// DELETE /businesses/:id/article-lists/:listId
// ============================================================================
exports.deleteList = async (req, res) => {
  try {
    const bizId = getBusinessId(req);
    const listId = safeNum(req.params.listId);

    if (!Number.isFinite(bizId) || !listId) {
      return res.status(400).json({ ok: false, error: 'parámetros inválidos' });
    }

    const { rowCount } = await pool.query(
      `DELETE FROM article_lists WHERE id = $1 AND business_id = $2`,
      [listId, bizId]
    );

    if (!rowCount) {
      return res.status(404).json({ ok: false, error: 'Lista no encontrada' });
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error('[deleteList]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

/* ========================= ITEMS DE LISTA ========================= */

// ============================================================================
// GET /businesses/:id/article-lists/:listId/items
// ============================================================================
exports.getListItems = async (req, res) => {
  try {
    const bizId = getBusinessId(req);
    const listId = safeNum(req.params.listId);

    if (!Number.isFinite(bizId) || !listId) {
      return res.status(400).json({ ok: false, error: 'parámetros inválidos' });
    }

    // Verificar que la lista pertenezca al negocio
    const { rows: listRows } = await pool.query(
      `SELECT id FROM article_lists WHERE id = $1 AND business_id = $2`,
      [listId, bizId]
    );
    if (!listRows.length) {
      return res.status(404).json({ ok: false, error: 'Lista no encontrada' });
    }

    const { rows } = await pool.query(
      `SELECT article_id, added_at
       FROM article_list_items
       WHERE list_id = $1
       ORDER BY added_at ASC`,
      [listId]
    );

    return res.json({ ok: true, items: rows });
  } catch (e) {
    console.error('[getListItems]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

// ============================================================================
// PUT /businesses/:id/article-lists/:listId/items
// Body: { ids: number[] }
// Agrega artículos a la lista (upsert — no duplica).
// ============================================================================
exports.addListItems = async (req, res) => {
  try {
    const bizId = getBusinessId(req);
    const listId = safeNum(req.params.listId);
    const ids = (Array.isArray(req.body?.ids) ? req.body.ids : [])
      .map(Number).filter(Number.isFinite);

    if (!Number.isFinite(bizId) || !listId || !ids.length) {
      return res.status(400).json({ ok: false, error: 'parámetros inválidos' });
    }

    // Verificar que la lista pertenezca al negocio
    const { rows: listRows } = await pool.query(
      `SELECT id FROM article_lists WHERE id = $1 AND business_id = $2`,
      [listId, bizId]
    );
    if (!listRows.length) {
      return res.status(404).json({ ok: false, error: 'Lista no encontrada' });
    }

    // Insertar en batch con ON CONFLICT DO NOTHING para no duplicar
    const values = ids.map((_, i) => `($1, $${i + 2})`).join(', ');
    const { rowCount } = await pool.query(
      `INSERT INTO article_list_items (list_id, article_id)
       VALUES ${values}
       ON CONFLICT (list_id, article_id) DO NOTHING`,
      [listId, ...ids]
    );

    return res.json({ ok: true, added: rowCount });
  } catch (e) {
    console.error('[addListItems]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

// ============================================================================
// DELETE /businesses/:id/article-lists/:listId/items/:articleId
// ============================================================================
exports.removeListItem = async (req, res) => {
  try {
    const bizId = getBusinessId(req);
    const listId = safeNum(req.params.listId);
    const articleId = safeNum(req.params.articleId);

    if (!Number.isFinite(bizId) || !listId || !articleId) {
      return res.status(400).json({ ok: false, error: 'parámetros inválidos' });
    }

    // Verificar que la lista pertenezca al negocio
    const { rows: listRows } = await pool.query(
      `SELECT id FROM article_lists WHERE id = $1 AND business_id = $2`,
      [listId, bizId]
    );
    if (!listRows.length) {
      return res.status(404).json({ ok: false, error: 'Lista no encontrada' });
    }

    await pool.query(
      `DELETE FROM article_list_items WHERE list_id = $1 AND article_id = $2`,
      [listId, articleId]
    );

    return res.json({ ok: true });
  } catch (e) {
    console.error('[removeListItem]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};
/* ========================= LISTAS DE INSUMOS ========================= */

// GET /businesses/:id/article-lists?scope=insumo
// (reutiliza getLists con filtro de scope)
exports.getInsumoLists = async (req, res) => {
  try {
    const bizId = getBusinessId(req);
    if (!Number.isFinite(bizId))
      return res.status(400).json({ ok: false, error: 'businessId inválido' });

    const { rows } = await pool.query(
      `SELECT
         l.id, l.name, l.description, l.color, l.created_at, l.updated_at,
         COUNT(li.id)::int AS item_count
       FROM article_lists l
       LEFT JOIN insumo_list_items li ON li.list_id = l.id
       WHERE l.business_id = $1 AND l.scope = 'insumo'
       GROUP BY l.id
       ORDER BY l.created_at DESC`,
      [bizId]
    );
    return res.json({ ok: true, lists: rows });
  } catch (e) {
    console.error('[getInsumoLists]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

// POST /businesses/:id/insumo-lists  { name }
exports.createInsumoList = async (req, res) => {
  try {
    const bizId = getBusinessId(req);
    if (!Number.isFinite(bizId))
      return res.status(400).json({ ok: false, error: 'businessId inválido' });

    const name = String(req.body?.name ?? '').trim();
    if (!name)
      return res.status(400).json({ ok: false, error: 'El nombre es obligatorio' });

    const { rows } = await pool.query(
      `INSERT INTO article_lists (business_id, name, scope)
       VALUES ($1, $2, 'insumo')
       RETURNING id, name, scope, created_at`,
      [bizId, name]
    );
    return res.status(201).json({ ok: true, list: rows[0] });
  } catch (e) {
    if (e.code === '23505')
      return res.status(409).json({ ok: false, error: 'Ya existe una lista con ese nombre' });
    console.error('[createInsumoList]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

// DELETE /businesses/:id/insumo-lists/:listId
exports.deleteInsumoList = async (req, res) => {
  try {
    const bizId = getBusinessId(req);
    const listId = safeNum(req.params.listId);
    if (!Number.isFinite(bizId) || !listId)
      return res.status(400).json({ ok: false, error: 'parámetros inválidos' });

    const { rowCount } = await pool.query(
      `DELETE FROM article_lists WHERE id = $1 AND business_id = $2 AND scope = 'insumo'`,
      [listId, bizId]
    );
    if (!rowCount)
      return res.status(404).json({ ok: false, error: 'Lista no encontrada' });

    return res.json({ ok: true });
  } catch (e) {
    console.error('[deleteInsumoList]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

// GET /businesses/:id/insumo-lists/:listId/items
exports.getInsumoListItems = async (req, res) => {
  try {
    const bizId = getBusinessId(req);
    const listId = safeNum(req.params.listId);
    if (!Number.isFinite(bizId) || !listId)
      return res.status(400).json({ ok: false, error: 'parámetros inválidos' });

    const { rows } = await pool.query(
      `SELECT ili.insumo_id, i.nombre, i.codigo_maxi, ili.added_at
       FROM insumo_list_items ili
       JOIN insumos i ON i.id = ili.insumo_id
       WHERE ili.list_id = $1
       ORDER BY ili.added_at ASC`,
      [listId]
    );
    return res.json({ ok: true, items: rows });
  } catch (e) {
    console.error('[getInsumoListItems]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

// PUT /businesses/:id/insumo-lists/:listId/items  { ids: number[] }
exports.addInsumoListItems = async (req, res) => {
  try {
    const bizId = getBusinessId(req);
    const listId = safeNum(req.params.listId);
    const ids = (Array.isArray(req.body?.ids) ? req.body.ids : [])
      .map(Number).filter(Number.isFinite);

    if (!Number.isFinite(bizId) || !listId || !ids.length)
      return res.status(400).json({ ok: false, error: 'parámetros inválidos' });

    const values = ids.map((_, i) => `($1, $${i + 2})`).join(', ');
    const { rowCount } = await pool.query(
      `INSERT INTO insumo_list_items (list_id, insumo_id)
       VALUES ${values}
       ON CONFLICT (list_id, insumo_id) DO NOTHING`,
      [listId, ...ids]
    );
    return res.json({ ok: true, added: rowCount });
  } catch (e) {
    console.error('[addInsumoListItems]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};