// services/catalogSyncService.js
const pool = require('../config/db');
const { fetchMenu } = require('./maxiMenuService');
const { saveMenuCache, flattenMenu, upsertArticleMap } = require('./maxiMenuCacheStore');

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

const norm = s => String(s || '').trim();
const isEmpty = s => norm(s) === '' || /^sin\s+(cat|categ|subrubro)/i.test(norm(s)) || /^-+$/.test(norm(s));

async function ensureTaxonomyIds(client, pairs) {
  const cats = new Set();
  const subs = new Set();
  for (const p of pairs) {
    const c = norm(p.categoria);
    const s = norm(p.subrubro);
    const cn = isEmpty(c) ? '[PENDIENTE]' : c;
    const sn = isEmpty(s) ? '[PENDIENTE]' : s;
    cats.add(cn);
    subs.add(`${cn}|${sn}`);
  }

  const catList = Array.from(cats);
  const subList = Array.from(subs).map(x => {
    const [c, s] = x.split('|');
    return { categoria: c, subrubro: s };
  });

  if (catList.length) {
    await client.query(
      `INSERT INTO categorias (nombre)
       SELECT UNNEST($1::text[])
       ON CONFLICT (nombre) DO NOTHING`,
      [catList]
    );
  }

  const { rows: catRows } = await client.query(
    `SELECT id, nombre FROM categorias WHERE nombre = ANY($1::text[])`,
    [catList]
  );
  const categoriaIdByName = new Map(catRows.map(r => [r.nombre, r.id]));

  if (subList.length) {
    const subCatIds = subList.map(p => categoriaIdByName.get(p.categoria));
    const subNames  = subList.map(p => p.subrubro);
    await client.query(
      `INSERT INTO subrubros (categoria_id, nombre)
       SELECT * FROM UNNEST($1::int[], $2::text[])
       ON CONFLICT (categoria_id, nombre) DO NOTHING`,
      [subCatIds, subNames]
    );
  }

  const { rows: subRows } = await client.query(
    `SELECT s.id, s.nombre, s.categoria_id, c.nombre AS categoria
       FROM subrubros s
       JOIN categorias c ON c.id = s.categoria_id
      WHERE (c.nombre, s.nombre) IN (
        SELECT * FROM UNNEST($1::text[], $2::text[])
      )`,
    [subList.map(p => p.categoria), subList.map(p => p.subrubro)]
  );
  const subrubroIdByPair = new Map(
    subRows.map(r => [`${r.categoria}|${r.nombre}`, r.id])
  );

  return { categoriaIdByName, subrubroIdByPair };
}

async function syncCatalogFromMenu({ businessId, req, listmode, list, id_tienda }) {
  const content = await fetchMenu({ businessId, req, listmode, list, id_tienda });

  try {
    await saveMenuCache(businessId, content, 'menuweb/menuextendido');
    const rows = flattenMenu(businessId, content);
    await upsertArticleMap(rows);
  } catch (e) {
    console.warn('[syncCatalogFromMenu] cache/map warn:', e?.message);
  }

  const articles = [];
  for (const rub of content) {
    if (rub?.node_type !== 'RUBRO') continue;
    const rubroName = norm(rub?.nombre);

    for (const a of (rub?.articulos || [])) {
      const prices = extractPrices(a, listmode);
      articles.push({
        id: Number(a.id),
        business_id: Number(businessId),
        name: norm(a.nombre),
        rubro: isEmpty(rubroName) ? '[PENDIENTE]' : rubroName,
        subrubro: '[PENDIENTE]',
        node_type: String(a.node_type || 'ARTICULO'),
        price: prices.price,
        props: { ...prices.props, visible: a.visible ?? 1, descripc: a.descripc ?? '' },
      });
    }

    for (const s of (rub?.subrubros || [])) {
      const subName = norm(s?.nombre);
      for (const a of (s?.articulos || [])) {
        const prices = extractPrices(a, listmode);
        articles.push({
          id: Number(a.id),
          business_id: Number(businessId),
          name: norm(a.nombre),
          rubro: isEmpty(rubroName) ? '[PENDIENTE]' : rubroName,
          subrubro: isEmpty(subName) ? '[PENDIENTE]' : subName,
          node_type: String(a.node_type || 'ARTICULO'),
          price: prices.price,
          props: { ...prices.props, visible: a.visible ?? 1, descripc: a.descripc ?? '' },
        });
      }
    }
  }

  if (!articles.length) return { ok: true, articles: 0 };

  const pairs = articles.map(a => ({ categoria: a.rubro, subrubro: a.subrubro }));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { categoriaIdByName, subrubroIdByPair } = await ensureTaxonomyIds(client, pairs);

    const bizArr   = articles.map(a => a.business_id);
    const idArr    = articles.map(a => a.id);
    const nameArr  = articles.map(a => a.name);
    const rubArr   = articles.map(a => a.rubro);
    const srbArr   = articles.map(a => a.subrubro);
    const typeArr  = articles.map(a => a.node_type);
    const priceArr = articles.map(a => a.price);
    const propsArr = articles.map(a => a.props);
    const catIdArr = articles.map(a => categoriaIdByName.get(a.rubro) || 1);
    const subIdArr = articles.map(a => subrubroIdByPair.get(`${a.rubro}|${a.subrubro}`) || 1);

    await client.query(
      `
      INSERT INTO app_articles
        (id, business_id, name, rubro, subrubro, node_type, price, props, categoria_id, subrubro_id, updated_at)
      SELECT * FROM UNNEST(
        $1::int[],  $2::int[], $3::text[], $4::text[], $5::text[],
        $6::text[], $7::numeric[], $8::jsonb[], $9::int[], $10::int[],
        ARRAY[NOW()]::timestamptz[]
      )
      ON CONFLICT (id)
      DO UPDATE SET
        business_id = EXCLUDED.business_id,
        name        = EXCLUDED.name,
        rubro       = EXCLUDED.rubro,
        subrubro    = EXCLUDED.subrubro,
        node_type   = EXCLUDED.node_type,
        price       = EXCLUDED.price,
        props       = EXCLUDED.props,
        categoria_id= EXCLUDED.categoria_id,
        subrubro_id = EXCLUDED.subrubro_id,
        updated_at  = NOW()
      `,
      [idArr, bizArr, nameArr, rubArr, srbArr, typeArr, priceArr, propsArr, catIdArr, subIdArr]
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
