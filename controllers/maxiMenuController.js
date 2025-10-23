// controllers/maxiMenuController.js
const { fetchMenu } = require('../services/maxiMenuService');
const { saveMenuCache, flattenMenu, upsertArticleMap } = require('../services/maxiMenuCacheStore');

async function refreshMenu(req, res, next) {
  try {
    const bizId =
      Number(req.business?.id) ||
      Number(req.params.id) ||
      Number(req.headers['x-business-id']);
    if (!Number.isFinite(bizId)) return res.status(400).json({ error: 'invalid_business_id' });

    const { listmode, list, id_tienda } = req.query;

    // 1) fetch a Maxi
    const content = await fetchMenu({ businessId: bizId, req, listmode, list, id_tienda });

    // 2) guardar cache cruda (array de rubros)
    const { hash } = await saveMenuCache(bizId, content);

    // 3) aplanar y upsert a tabla lookup
    const rows = flattenMenu(bizId, content);
    const resUp = await upsertArticleMap(rows);

    res.json({
      ok: true,
      business_id: bizId,
      hash,
      rubros: content.length || 0,
      mapped_rows: resUp.upserted,
    });
  } catch (e) { next(e); }
}

module.exports = { refreshMenu };
