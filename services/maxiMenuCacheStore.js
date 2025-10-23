// services/maxiMenuCacheStore.js
const crypto = require('crypto');
const pool = require('../config/db');

/** Guarda la cache cruda en maxi_menu_cache con un hash para deduplicar */
async function saveMenuCache(businessId, payload, source = 'menuweb/menuextendido') {
  const json = JSON.stringify(payload);
  const hash = crypto.createHash('sha1').update(json).digest('hex');

  // upsert por (business_id, hash) → si es igual al último, sólo tocamos updated_at
  await pool.query(`
    INSERT INTO public.maxi_menu_cache (business_id, source, payload, hash)
    VALUES ($1, $2, $3::jsonb, $4)
    ON CONFLICT (business_id, hash) DO UPDATE
      SET updated_at = now()
  `, [businessId, source, json, hash]);

  return { hash };
}

/** Aplana el payload (array de rubros) a filas por ARTICULO/ARTICULO_PROMO */
function flattenMenu(businessId, content) {
  const rows = [];
  if (!Array.isArray(content)) return rows;

  for (const r of content) {
    const rubroId = Number(r?.id) || null;
    const rubroNombre = r?.nombre || null;

    // Artículos directamente bajo el rubro
    const artsRub = Array.isArray(r?.articulos) ? r.articulos : [];
    for (const a of artsRub) {
      const articleId = Number(a?.id);
      if (!Number.isFinite(articleId)) continue;
      rows.push({
        business_id: businessId,
        article_id: articleId,
        rubro_id: rubroId,
        rubro_nombre: rubroNombre,
        subrubro_id: null,
        subrubro_nombre: null,
        node_type: a?.node_type || null,
        nombre: a?.nombre || null,
        precio: a?.precio ?? null,
      });
    }

    // Artículos en subrubros
    const subs = Array.isArray(r?.subrubros) ? r.subrubros : [];
    for (const s of subs) {
      const subId = Number(s?.id) || null;
      const subNom = s?.nombre || null;

      const artsSub = Array.isArray(s?.articulos) ? s.articulos : [];
      for (const a of artsSub) {
        const articleId = Number(a?.id);
        if (!Number.isFinite(articleId)) continue;
        rows.push({
          business_id: businessId,
          article_id: articleId,
          rubro_id: rubroId,
          rubro_nombre: rubroNombre,
          subrubro_id: subId,
          subrubro_nombre: subNom,
          node_type: a?.node_type || null,
          nombre: a?.nombre || null,
          precio: a?.precio ?? null,
        });
      }
    }
  }
  return rows;
}

/** Upsert batch a maxi_article_map (idempotente por (business_id, article_id)) */
async function upsertArticleMap(rows) {
  if (!rows.length) return { upserted: 0 };

  const bizArr   = rows.map(x => x.business_id);
  const artArr   = rows.map(x => x.article_id);
  const rubArr   = rows.map(x => x.rubro_id);
  const rubNom   = rows.map(x => x.rubro_nombre);
  const subIdArr = rows.map(x => x.subrubro_id);
  const subNom   = rows.map(x => x.subrubro_nombre);
  const typeArr  = rows.map(x => x.node_type);
  const nomArr   = rows.map(x => x.nombre);
  const preArr   = rows.map(x => x.precio);

  await pool.query(`
    INSERT INTO public.maxi_article_map
      (business_id, article_id, rubro_id, rubro_nombre, subrubro_id, subrubro_nombre, node_type, nombre, precio, updated_at)
    SELECT * FROM UNNEST(
      $1::int[], $2::int[], $3::int[], $4::text[], $5::int[], $6::text[], $7::text[], $8::text[], $9::numeric[], ARRAY(SELECT now() FROM generate_series(1, $10))
    )
    ON CONFLICT (business_id, article_id) DO UPDATE SET
      rubro_id        = EXCLUDED.rubro_id,
      rubro_nombre    = EXCLUDED.rubro_nombre,
      subrubro_id     = EXCLUDED.subrubro_id,
      subrubro_nombre = EXCLUDED.subrubro_nombre,
      node_type       = EXCLUDED.node_type,
      nombre          = EXCLUDED.nombre,
      precio          = EXCLUDED.precio,
      updated_at      = now()
  `, [bizArr, artArr, rubArr, rubNom, subIdArr, subNom, typeArr, nomArr, preArr, rows.length]);

  return { upserted: rows.length };
}

module.exports = {
  saveMenuCache,
  flattenMenu,
  upsertArticleMap,
};
