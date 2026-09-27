// controllers/articleListsController.js
// Listas de artículos (sidebar) e insumos.
// Tabla: article_lists con scope IN ('article', 'insumo').
// Las listas de precios viven en price_lists y se manejan por priceListsController.

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

/* ========================= LISTAS DE ARTÍCULOS ========================= */

// GET /businesses/:id/article-lists
exports.getLists = async (req, res) => {
  try {
    const bizId = getBusinessId(req);
    if (!Number.isFinite(bizId)) {
      return res.status(400).json({ ok: false, error: 'businessId inválido' });
    }

    const { rows } = await pool.query(
      `SELECT
         l.id, l.name, l.description, l.color,
         l.created_at, l.updated_at,
         COUNT(li.id)::int AS item_count
       FROM article_lists l
       LEFT JOIN article_list_items li ON li.list_id = l.id
       WHERE l.business_id = $1 AND l.scope = 'article'
       GROUP BY l.id
       ORDER BY l.created_at DESC`,
      [bizId]
    );

    return res.json({ ok: true, lists: rows });
  } catch (e) {
    console.error('[articleLists.getLists]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

// POST /businesses/:id/article-lists
// Body opcional: { ids: [articleId, ...] } — si viene, la lista se crea CON
// sus artículos en la misma transacción. Antes era un POST (header) seguido
// de un PUT (items) desde el front, sin transacción: si el segundo pedido
// fallaba por lo que fuera, la lista quedaba creada pero vacía para siempre.
exports.createList = async (req, res) => {
  const client = await pool.connect();
  try {
    const bizId = getBusinessId(req);
    if (!Number.isFinite(bizId)) {
      return res.status(400).json({ ok: false, error: 'businessId inválido' });
    }

    const name = String(req.body?.name ?? '').trim();
    const description = String(req.body?.description ?? '').trim() || null;
    const color = String(req.body?.color ?? '').trim() || null;
    const ids = (Array.isArray(req.body?.ids) ? req.body.ids : [])
      .map(Number).filter(Number.isFinite);

    if (!name) {
      return res.status(400).json({ ok: false, error: 'El nombre es obligatorio' });
    }

    await client.query('BEGIN');

    const { rows } = await client.query(
      `INSERT INTO article_lists
         (business_id, name, description, color, scope)
       VALUES ($1, $2, $3, $4, 'article')
       RETURNING id, name, description, color, created_at`,
      [bizId, name, description, color]
    );
    const list = rows[0];

    let added = 0;
    if (ids.length) {
      const values = ids.map((_, i) => `($1, $${i + 2})`).join(', ');
      const itemsRes = await client.query(
        `INSERT INTO article_list_items (list_id, article_id)
         VALUES ${values}
         ON CONFLICT (list_id, article_id) DO NOTHING`,
        [list.id, ...ids]
      );
      added = itemsRes.rowCount;
    }

    await client.query('COMMIT');
    return res.status(201).json({ ok: true, list, added });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { }
    if (e.code === '23505') {
      return res.status(409).json({ ok: false, error: 'Ya existe una lista con ese nombre' });
    }
    console.error('[articleLists.createList]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  } finally {
    client.release();
  }
};

// PUT /businesses/:id/article-lists/:listId
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
       WHERE id = $${vals.length + 1}
         AND business_id = $${vals.length + 2}
         AND scope = 'article'
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
    console.error('[articleLists.updateList]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

// DELETE /businesses/:id/article-lists/:listId
exports.deleteList = async (req, res) => {
  try {
    const bizId = getBusinessId(req);
    const listId = safeNum(req.params.listId);

    if (!Number.isFinite(bizId) || !listId) {
      return res.status(400).json({ ok: false, error: 'parámetros inválidos' });
    }

    const { rowCount } = await pool.query(
      `DELETE FROM article_lists
       WHERE id = $1 AND business_id = $2 AND scope = 'article'`,
      [listId, bizId]
    );

    if (!rowCount) {
      return res.status(404).json({ ok: false, error: 'Lista no encontrada' });
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error('[articleLists.deleteList]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

/* ========================= ITEMS DE LISTA DE ARTÍCULOS ========================= */

// GET /businesses/:id/article-lists/:listId/items
exports.getListItems = async (req, res) => {
  try {
    const bizId = getBusinessId(req);
    const listId = safeNum(req.params.listId);

    if (!Number.isFinite(bizId) || !listId) {
      return res.status(400).json({ ok: false, error: 'parámetros inválidos' });
    }

    const { rows: listRows } = await pool.query(
      `SELECT id FROM article_lists 
        WHERE id = $1 AND business_id = $2 AND scope = 'article'`,
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
    console.error('[articleLists.getListItems]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

// PUT /businesses/:id/article-lists/:listId/items
exports.addListItems = async (req, res) => {
  try {
    const bizId = getBusinessId(req);
    const listId = safeNum(req.params.listId);
    const ids = (Array.isArray(req.body?.ids) ? req.body.ids : [])
      .map(Number).filter(Number.isFinite);

    if (!Number.isFinite(bizId) || !listId || !ids.length) {
      return res.status(400).json({ ok: false, error: 'parámetros inválidos' });
    }

    const { rows: listRows } = await pool.query(
      `SELECT id FROM article_lists 
        WHERE id = $1 AND business_id = $2 AND scope = 'article'`,
      [listId, bizId]
    );
    if (!listRows.length) {
      return res.status(404).json({ ok: false, error: 'Lista no encontrada' });
    }

    const values = ids.map((_, i) => `($1, $${i + 2})`).join(', ');
    const { rowCount } = await pool.query(
      `INSERT INTO article_list_items (list_id, article_id)
       VALUES ${values}
       ON CONFLICT (list_id, article_id) DO NOTHING`,
      [listId, ...ids]
    );

    return res.json({ ok: true, added: rowCount });
  } catch (e) {
    console.error('[articleLists.addListItems]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

// DELETE /businesses/:id/article-lists/:listId/items/:articleId
exports.removeListItem = async (req, res) => {
  try {
    const bizId = getBusinessId(req);
    const listId = safeNum(req.params.listId);
    const articleId = safeNum(req.params.articleId);

    if (!Number.isFinite(bizId) || !listId || !articleId) {
      return res.status(400).json({ ok: false, error: 'parámetros inválidos' });
    }

    const { rows: listRows } = await pool.query(
      `SELECT id FROM article_lists 
        WHERE id = $1 AND business_id = $2 AND scope = 'article'`,
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
    console.error('[articleLists.removeListItem]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

/* ========================= LISTAS DE INSUMOS ========================= */

// GET /businesses/:id/insumo-lists
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
    console.error('[articleLists.getInsumoLists]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

// POST /businesses/:id/insumo-lists
// Mismo criterio que createList (artículos): si viene `ids`, se crea la
// lista y se cargan sus insumos en la misma transacción — antes era un
// POST (header) + PUT (items) sin transacción desde el front, y si el
// segundo pedido fallaba la lista quedaba creada pero vacía para siempre.
exports.createInsumoList = async (req, res) => {
  const client = await pool.connect();
  try {
    const bizId = getBusinessId(req);
    if (!Number.isFinite(bizId))
      return res.status(400).json({ ok: false, error: 'businessId inválido' });

    const name = String(req.body?.name ?? '').trim();
    if (!name)
      return res.status(400).json({ ok: false, error: 'El nombre es obligatorio' });

    const ids = (Array.isArray(req.body?.ids) ? req.body.ids : [])
      .map(Number).filter(Number.isFinite);

    await client.query('BEGIN');

    const { rows } = await client.query(
      `INSERT INTO article_lists (business_id, name, scope)
       VALUES ($1, $2, 'insumo')
       RETURNING id, name, scope, created_at`,
      [bizId, name]
    );
    const list = rows[0];

    let added = 0;
    if (ids.length) {
      const values = ids.map((_, i) => `($1, $${i + 2})`).join(', ');
      const itemsRes = await client.query(
        `INSERT INTO insumo_list_items (list_id, insumo_id)
         VALUES ${values}
         ON CONFLICT (list_id, insumo_id) DO NOTHING`,
        [list.id, ...ids]
      );
      added = itemsRes.rowCount;
    }

    await client.query('COMMIT');
    return res.status(201).json({ ok: true, list, added });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { }
    if (e.code === '23505')
      return res.status(409).json({ ok: false, error: 'Ya existe una lista con ese nombre' });
    console.error('[articleLists.createInsumoList]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  } finally {
    client.release();
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
    console.error('[articleLists.deleteInsumoList]', e.message);
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
    console.error('[articleLists.getInsumoListItems]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

// PUT /businesses/:id/insumo-lists/:listId/items
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
    console.error('[articleLists.addInsumoListItems]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};