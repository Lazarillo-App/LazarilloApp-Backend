// services/catalogSyncService.js
const pool = require('../config/db');
const { fetchMenu } = require('./maxiMenuService');

// Si pedís listmode=ATOM, Maxi manda precio1..precio4. Los guardamos en props.
function extractPrices(node, listmode) {
  const base = { price: Number(node?.precio ?? 0) || 0, props: {} };
  if ((listmode || '').toUpperCase() === 'ATOM') {
    base.props.precio1 = Number(node?.precio1 ?? 0) || 0;
    base.props.precio2 = Number(node?.precio2 ?? 0) || 0;
    base.props.precio3 = Number(node?.precio3 ?? 0) || 0;
    base.props.precio4 = Number(node?.precio4 ?? 0) || 0;
  }
  return base;
}

/**
 * Baja el menú y hace UPSERT en app_articles (sin crear tablas nuevas).
 * Campos que llenamos: id, name, rubro, subrubro, node_type, price, props, updated_at
 */
async function syncCatalogFromMenu({ businessId, req, listmode, list, id_tienda }) {
  const content = await fetchMenu({ businessId, req, listmode, list, id_tienda });

  const articles = [];

  for (const rub of content) {
    if (rub?.node_type !== 'RUBRO') continue;
    const rubroName = String(rub?.nombre || '').trim();

    // Artículos directos del rubro
    for (const a of (rub?.articulos || [])) {
      const prices = extractPrices(a, listmode);
      articles.push({
        id: Number(a.id),
        name: String(a.nombre || '').trim(),
        rubro: rubroName,
        subrubro: null,
        node_type: String(a.node_type || 'ARTICULO'),
        price: prices.price,
        props: { ...prices.props, visible: a.visible ?? 1, descripc: a.descripc ?? '' },
      });
    }

    // Subrubros (si vienen)
    for (const s of (rub?.subrubros || [])) {
      const subName = String(s?.nombre || '').trim();
      for (const a of (s?.articulos || [])) {
        const prices = extractPrices(a, listmode);
        articles.push({
          id: Number(a.id),
          name: String(a.nombre || '').trim(),
          rubro: rubroName,
          subrubro: subName,
          node_type: String(a.node_type || 'ARTICULO'),
          price: prices.price,
          props: { ...prices.props, visible: a.visible ?? 1, descripc: a.descripc ?? '' },
        });
      }
    }
  }

  if (!articles.length) return { ok: true, articles: 0 };

  // UPSERT batch a app_articles
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const idArr    = articles.map(a => a.id);
    const nameArr  = articles.map(a => a.name);
    const rubArr   = articles.map(a => a.rubro);
    const srbArr   = articles.map(a => a.subrubro);
    const typeArr  = articles.map(a => a.node_type);
    const priceArr = articles.map(a => a.price);
    const propsArr = articles.map(a => a.props);

    await client.query(
      `
      INSERT INTO app_articles (id, name, rubro, subrubro, node_type, price, props, updated_at)
      SELECT * FROM UNNEST(
        $1::int[],  $2::text[], $3::text[], $4::text[],
        $5::text[], $6::numeric[], $7::jsonb[], ARRAY[NOW()]::timestamptz[]
      )
      ON CONFLICT (id)
      DO UPDATE SET
        name      = EXCLUDED.name,
        rubro     = EXCLUDED.rubro,
        subrubro  = EXCLUDED.subrubro,
        node_type = EXCLUDED.node_type,
        price     = EXCLUDED.price,
        props     = EXCLUDED.props,
        updated_at= NOW()
      `,
      [idArr, nameArr, rubArr, srbArr, typeArr, priceArr, propsArr]
    );

    await client.query('COMMIT');
    return { ok: true, articles: articles.length };
  } catch (e) {
    await client.query('ROLLBACK');
    e.status = e.status || 500;
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { syncCatalogFromMenu };
