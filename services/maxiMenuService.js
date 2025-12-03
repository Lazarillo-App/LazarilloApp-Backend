// services/maxiMenuService.js
const fetch = require('node-fetch');
const { getBearer } = require('./maxiSalesService');
const pool = require('../config/db');

const MAXI_BASE = process.env.MAXI_BASE_URL || 'https://api-mconn.maxisistemas.com.ar';

/* ───────── URL helper ───────── */

function buildMenuUrl({ listmode, list, id_tienda }) {
  const u = new URL(`${MAXI_BASE.replace(/\/+$/, '')}/menuweb/menuextendido`);
  if (listmode)  u.searchParams.set('listmode', listmode);   // ONLY | ATOM
  if (list)      u.searchParams.set('list', String(list));   // "3" o "1,2,3,4"
  if (id_tienda) u.searchParams.set('id_tienda', String(id_tienda));
  return u.toString();
}

/* ───────── Fetch del menú directo a Maxi ───────── */

async function fetchMenu({ businessId, req, listmode, list, id_tienda }) {
  const bearer = await getBearer(businessId, req); // respeta X-Maxi-Token o credenciales guardadas
  const url = buildMenuUrl({ listmode, list, id_tienda });

  const r = await fetch(url, {
    headers: {
      Authorization: `Bearer ${bearer}`,
      Accept: 'application/json',
    },
  });

  const txt = await r.text().catch(() => '');
  let j;
  try { j = JSON.parse(txt); } catch {}

  if (!r.ok || j?.resultCode !== 'SUCCESS') {
    const e = new Error(j?.resultDescription || r.statusText || 'menu fetch failed');
    e.status = r.status || 502;
    e._body = txt.slice(0, 400);
    throw e;
  }

  // Devuelve array de rubros (estructura del doc)
  return j?.content || [];
}

/* ───────── Helper: aplanar árbol en artículos ───────── */
/**
 * Convierte el árbol devuelto por /menuweb/menuextendido
 * en una lista plana de artículos:
 *   { articulo_id, nombre, categoria, subrubro, precio, costo, raw }
 */
function flattenMenuToArticles(menu) {
  const out = [];

  function walk(node, ctx) {
    if (!node || typeof node !== 'object') return;

    const nodeType = String(node.node_type || node.type || '').toUpperCase();
    const nombre = node.nombre || node.name || node.title || null;

    // Clonar contexto
    let nextCtx = { ...ctx };

    // Nivel "rubro" / "categoría"
    if (nodeType === 'RUBRO' || nodeType === 'CATEGORIA') {
      if (nombre) nextCtx.categoria = nombre;
    }

    // Nivel "subrubro"
    if (nodeType === 'SUBRUBRO') {
      if (nombre) nextCtx.subrubro = nombre;
    }

    // Nivel "artículo"
    if (nodeType === 'ARTICULO' || (!Array.isArray(node.hijos) && !Array.isArray(node.children))) {
      const rawId = node.id ?? node.articulo_id ?? node.codigo ?? node.code;
      const articuloId = Number(rawId);

      if (!Number.isFinite(articuloId)) return;

      const precio = Number(node.precio ?? node.price ?? 0) || 0;
      const costo  = Number(node.costo ?? node.cost ?? 0) || 0;

      out.push({
        articulo_id: articuloId,
        nombre: nombre || `ART-${articuloId}`,
        categoria: nextCtx.categoria || null,
        subrubro: nextCtx.subrubro || null,
        precio,
        costo,
        raw: node,
      });
      return;
    }

    const hijos = node.hijos || node.children || [];
    if (Array.isArray(hijos)) {
      hijos.forEach((h) => walk(h, nextCtx));
    }
  }

  (menu || []).forEach((root) => walk(root, {}));
  return out;
}

/* ───────── Import completo de menú para un negocio ───────── */
/**
 * Paso central del onboarding de ventas:
 *  - trae el menú desde Maxi,
 *  - llena/actualiza maxi_articles,
 *  - llena/actualiza maxi_article_map con external_code + title.
 *
 * NO crea todavía app_articles (eso lo puede hacer un paso separado
 * como /:businessId/rebuild-article-map).
 */
async function importMaxiMenuForBusiness(businessId, options = {}) {
  const bizId = Number(businessId);
  if (!Number.isFinite(bizId)) {
    throw new Error(`importMaxiMenuForBusiness: invalid businessId "${businessId}"`);
  }

  const {
    req = null,
    listmode = 'ONLY',
    list = undefined,
    id_tienda = undefined,
  } = options;

  // 1) Traer menú crudo desde Maxi
  const menu = await fetchMenu({ businessId: bizId, req, listmode, list, id_tienda });

  // 2) Aplanar en artículos
  const articles = flattenMenuToArticles(menu);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 3) maxi_articles: espejo ordenado del menú de Maxi
    if (articles.length > 0) {
      const values = [];
      const params = [];
      let i = 1;

      for (const a of articles) {
        values.push(
          `($${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++})`
        );
        params.push(
          bizId,                 // business_id
          a.articulo_id,         // articulo_id
          a.nombre,              // nombre
          a.categoria || null,   // categoria
          a.subrubro || null,    // subrubro
          a.precio,              // precio
          a.costo,               // costo
          JSON.stringify(a.raw), // raw
        );
      }

      await client.query(
        `
        INSERT INTO maxi_articles (
          business_id,
          articulo_id,
          nombre,
          categoria,
          subrubro,
          precio,
          costo,
          raw
        )
        VALUES
          ${values.join(', ')}
        ON CONFLICT (business_id, articulo_id)
        DO UPDATE SET
          nombre     = EXCLUDED.nombre,
          categoria  = EXCLUDED.categoria,
          subrubro   = EXCLUDED.subrubro,
          precio     = EXCLUDED.precio,
          costo      = EXCLUDED.costo,
          raw        = EXCLUDED.raw,
          updated_at = now()
        `,
        params
      );
    }

    // 4) maxi_article_map: base para mapping (sin tocar article_id)
    if (articles.length > 0) {
      const values2 = [];
      const params2 = [];
      let j = 1;

      for (const a of articles) {
        values2.push(
          `($${j++}, $${j++}, $${j++}, $${j++}, now(), $${j++}, $${j++})`
        );
        params2.push(
          bizId,                  // business_id
          a.articulo_id,          // articulo_id
          a.categoria || null,    // categoria
          a.subrubro || null,     // subrubro
          String(a.articulo_id),  // external_code (codigo externo de Maxi)
          a.nombre,               // title (nombre del artículo)
        );
      }

      await client.query(
        `
        INSERT INTO maxi_article_map (
          business_id,
          articulo_id,
          categoria,
          subrubro,
          updated_at,
          external_code,
          title
        )
        VALUES
          ${values2.join(', ')}
        ON CONFLICT (business_id, articulo_id)
        DO UPDATE SET
          categoria     = EXCLUDED.categoria,
          subrubro      = EXCLUDED.subrubro,
          updated_at    = now(),
          external_code = EXCLUDED.external_code,
          title         = EXCLUDED.title
        `,
        params2
      );
    }

    await client.query('COMMIT');

    return {
      ok: true,
      business_id: bizId,
      imported_articles: articles.length,
    };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

module.exports = {
  fetchMenu,
  importMaxiMenuForBusiness,
};
