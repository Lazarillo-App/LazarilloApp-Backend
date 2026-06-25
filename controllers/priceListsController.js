// controllers/priceListsController.js
// Listas de precios custom de Lazarillo (Salon, Mostrador, etc).
// Tabla: price_lists. Una favorita por negocio, las demás aplican ajuste_pct sobre la favorita.

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

// GET /businesses/:id/price-lists
exports.getLists = async (req, res) => {
  try {
    const bizId = getBusinessId(req);
    if (!Number.isFinite(bizId)) {
      return res.status(400).json({ ok: false, error: 'businessId inválido' });
    }

    const { rows } = await pool.query(
      `SELECT
         l.id, l.name, l.description, l.color,
         l.ajuste_pct, l.is_favorite, l.orden,
         l.created_at, l.updated_at
       FROM price_lists l
       WHERE l.business_id = $1
       ORDER BY l.orden ASC, l.created_at ASC`,
      [bizId]
    );

    return res.json({ ok: true, lists: rows });
  } catch (e) {
    console.error('[priceLists.getLists]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

// POST /businesses/:id/price-lists
exports.createList = async (req, res) => {
  try {
    const bizId = getBusinessId(req);
    if (!Number.isFinite(bizId)) {
      return res.status(400).json({ ok: false, error: 'businessId inválido' });
    }

    const name = String(req.body?.name ?? '').trim();
    const description = String(req.body?.description ?? '').trim() || null;
    const color = String(req.body?.color ?? '').trim() || null;
    const ajustePct = req.body?.ajuste_pct != null ? Number(req.body.ajuste_pct) : 0;

    if (!name) {
      return res.status(400).json({ ok: false, error: 'El nombre es obligatorio' });
    }

    const { rows: maxOrden } = await pool.query(
      `SELECT COALESCE(MAX(orden), 0) AS max_orden
         FROM price_lists
        WHERE business_id = $1`,
      [bizId]
    );
    const nextOrden = Number(maxOrden[0]?.max_orden || 0) + 1;

    const { rows } = await pool.query(
      `INSERT INTO price_lists
         (business_id, name, description, color, ajuste_pct, is_favorite, orden)
       VALUES ($1, $2, $3, $4, $5, FALSE, $6)
       RETURNING id, name, description, color, ajuste_pct, is_favorite, orden, created_at`,
      [bizId, name, description, color, ajustePct, nextOrden]
    );

    return res.status(201).json({ ok: true, list: rows[0] });
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ ok: false, error: 'Ya existe una lista con ese nombre' });
    }
    console.error('[priceLists.createList]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

// PUT /businesses/:id/price-lists/:listId
exports.updateList = async (req, res) => {
  try {
    const bizId = getBusinessId(req);
    const listId = safeNum(req.params.listId);

    if (!Number.isFinite(bizId) || !listId) {
      return res.status(400).json({ ok: false, error: 'parámetros inválidos' });
    }

    if (req.body?.is_favorite !== undefined) {
      return res.status(400).json({
        ok: false,
        error: 'Para cambiar la favorita usá el endpoint /set-favorite',
      });
    }

    if (req.body?.ajuste_pct !== undefined) {
      const { rows: chk } = await pool.query(
        `SELECT is_favorite FROM price_lists WHERE id = $1 AND business_id = $2`,
        [listId, bizId]
      );
      if (chk[0]?.is_favorite) {
        return res.status(400).json({
          ok: false,
          error: 'La lista favorita no puede tener ajuste_pct (siempre es 0)',
        });
      }
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
    if (req.body?.ajuste_pct !== undefined) push('ajuste_pct', Number(req.body.ajuste_pct) || 0);
    if (req.body?.orden !== undefined) push('orden', Number(req.body.orden) || 0);

    if (!sets.length) return res.json({ ok: true });

    const sql = `
      UPDATE price_lists
         SET ${sets.join(', ')}, updated_at = NOW()
       WHERE id = $${vals.length + 1}
         AND business_id = $${vals.length + 2}
       RETURNING id, name, description, color, ajuste_pct, is_favorite, orden, updated_at`;

    const { rows } = await pool.query(sql, [...vals, listId, bizId]);

    if (!rows.length) {
      return res.status(404).json({ ok: false, error: 'Lista no encontrada' });
    }

    return res.json({ ok: true, list: rows[0] });
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ ok: false, error: 'Ya existe una lista con ese nombre' });
    }
    console.error('[priceLists.updateList]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

// DELETE /businesses/:id/price-lists/:listId
exports.deleteList = async (req, res) => {
  try {
    const bizId = getBusinessId(req);
    const listId = safeNum(req.params.listId);

    if (!Number.isFinite(bizId) || !listId) {
      return res.status(400).json({ ok: false, error: 'parámetros inválidos' });
    }

    const { rows: chk } = await pool.query(
      `SELECT id, is_favorite FROM price_lists
        WHERE id = $1 AND business_id = $2`,
      [listId, bizId]
    );
    if (!chk.length) {
      return res.status(404).json({ ok: false, error: 'Lista no encontrada' });
    }
    if (chk[0].is_favorite) {
      return res.status(400).json({ ok: false, error: 'No se puede eliminar la lista favorita' });
    }

    await pool.query(
      `DELETE FROM price_lists WHERE id = $1 AND business_id = $2`,
      [listId, bizId]
    );

    return res.json({ ok: true });
  } catch (e) {
    console.error('[priceLists.deleteList]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

// POST /businesses/:id/price-lists/:listId/set-favorite
exports.setFavorite = async (req, res) => {
  const client = await pool.connect();
  try {
    const bizId = getBusinessId(req);
    const listId = safeNum(req.params.listId);
    if (!Number.isFinite(bizId) || !listId) {
      return res.status(400).json({ ok: false, error: 'parámetros inválidos' });
    }

    await client.query('BEGIN');

    const { rows: chk } = await client.query(
      `SELECT id FROM price_lists WHERE id = $1 AND business_id = $2`,
      [listId, bizId]
    );
    if (!chk.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'Lista no encontrada' });
    }

    await client.query(
      `UPDATE price_lists
          SET is_favorite = FALSE, updated_at = NOW()
        WHERE business_id = $1 AND is_favorite = TRUE`,
      [bizId]
    );

    await client.query(
      `UPDATE price_lists
          SET is_favorite = TRUE, ajuste_pct = 0, updated_at = NOW()
        WHERE id = $1`,
      [listId]
    );

    await client.query('COMMIT');
    return res.json({ ok: true });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('[priceLists.setFavorite]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  } finally {
    client.release();
  }
};

/* ========================= FULL STATE ========================= */

// GET /businesses/:id/price-lists/full-state
// Devuelve todas las listas + price_config en un solo request.
exports.getFullState = async (req, res) => {
  try {
    const bizId = getBusinessId(req);
    if (!Number.isFinite(bizId)) {
      return res.status(400).json({ ok: false, error: 'businessId inválido' });
    }

    const { rows: lists } = await pool.query(
      `SELECT id, name, description, color, ajuste_pct, is_favorite, orden
         FROM price_lists
        WHERE business_id = $1
        ORDER BY orden ASC, created_at ASC`,
      [bizId]
    );

    const { rows: configs } = await pool.query(
      `SELECT scope, scope_id, list_id, objetivo_pct, ajuste_pct, precio_manual, excluido
         FROM article_price_config
        WHERE business_id = $1`,
      [bizId]
    );

    const byList = { _base: { byArticle: {}, byRubro: {}, byAgrupacion: {} } };

    for (const l of lists) {
      byList[l.id] = { byArticle: {}, byRubro: {}, byAgrupacion: {} };
    }

    for (const r of configs) {
      const entry = {
        objetivo: r.objetivo_pct != null ? Number(r.objetivo_pct) : null,
        ajuste:   r.ajuste_pct   != null ? Number(r.ajuste_pct)   : null,
        precioManual: r.precio_manual != null ? Number(r.precio_manual) : null,
        excluido: !!r.excluido,
      };

      const target = r.list_id ? byList[r.list_id] : byList._base;
      if (!target) continue;

      const key = String(r.scope_id);
      if (r.scope === 'articulo')   target.byArticle[key] = entry;
      else if (r.scope === 'rubro') target.byRubro[key]   = entry;
      else if (r.scope === 'agrupacion') target.byAgrupacion[key] = entry;
    }

    return res.json({ ok: true, lists, byList });
  } catch (e) {
    console.error('[priceLists.getFullState]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};