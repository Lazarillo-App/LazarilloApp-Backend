// services/maxiMenuService.js - VERSIÓN CORREGIDA
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
  const bearer = await getBearer(businessId, req);
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

  return j?.content || [];
}

/* ───────── Helper: aplanar árbol en artículos ───────── */
/**
 * ✅ VERSIÓN CORREGIDA
 * 
 * Convierte el árbol devuelto por /menuweb/menuextendido
 * en una lista plana de artículos.
 * 
 * CORRECCIÓN: Solo agrega nodos con node_type === 'ARTICULO'
 * NO agrega rubros/categorías/subrubros
 */
function flattenMenuToArticles(menu) {
  const out = [];
  let rubrosSkipped = 0;

  function walk(node, ctx) {
    if (!node || typeof node !== 'object') return;

    const nodeType = String(node.node_type || node.type || '').toUpperCase();
    const nombre = node.nombre || node.name || node.title || null;

    // Clonar contexto
    let nextCtx = { ...ctx };

    // Nivel "rubro" / "categoría"
    if (nodeType === 'RUBRO' || nodeType === 'CATEGORIA') {
      if (nombre) nextCtx.categoria = nombre;
      rubrosSkipped++;
      // ✅ NO agregar a out, solo actualizar contexto
    }

    // Nivel "subrubro"
    if (nodeType === 'SUBRUBRO') {
      if (nombre) nextCtx.subrubro = nombre;
      rubrosSkipped++;
      // ✅ NO agregar a out, solo actualizar contexto
    }

    // ✅ CORRECCIÓN: Solo agregar si es ARTICULO explícitamente
    if (nodeType === 'ARTICULO') {
      const rawId = node.id ?? node.articulo_id ?? node.codigo ?? node.code;
      const articuloId = Number(rawId);

      if (!Number.isFinite(articuloId) || articuloId <= 0) {
        console.warn('[flattenMenuToArticles] Artículo sin ID válido:', { nombre, rawId });
        
        // Continuar navegando hijos por si acaso
        const hijos = node.hijos || node.children || [];
        if (Array.isArray(hijos)) {
          hijos.forEach((h) => walk(h, nextCtx));
        }
        return;
      }

      const precio = Number(node.precio ?? node.price ?? 0) || 0;
      const costo  = Number(node.costo ?? node.cost ?? 0) || 0;

      // ✅ Validación adicional: No agregar si precio = 0 Y categoria = nombre
      // (esto captura rubros que no tienen node_type correcto)
      if (precio === 0 && nombre && nextCtx.categoria === nombre) {
        console.warn('[flattenMenuToArticles] Posible rubro detectado por heurística:', { 
          articulo_id: articuloId, 
          nombre, 
          categoria: nextCtx.categoria 
        });
        rubrosSkipped++;
        
        // Continuar navegando hijos
        const hijos = node.hijos || node.children || [];
        if (Array.isArray(hijos)) {
          hijos.forEach((h) => walk(h, nextCtx));
        }
        return;
      }

      out.push({
        articulo_id: articuloId,
        nombre: nombre || `ART-${articuloId}`,
        categoria: nextCtx.categoria || null,
        subrubro: nextCtx.subrubro || null,
        precio,
        costo,
        raw: node,
      });
      
      // Los artículos normalmente NO tienen hijos, pero por si acaso
      const hijos = node.hijos || node.children || [];
      if (Array.isArray(hijos) && hijos.length > 0) {
        console.warn('[flattenMenuToArticles] Artículo con hijos (inusual):', articuloId);
        hijos.forEach((h) => walk(h, nextCtx));
      }
      return;
    }

    // Para cualquier otro tipo de nodo, seguir navegando hijos
    const hijos = node.hijos || node.children || [];
    if (Array.isArray(hijos)) {
      hijos.forEach((h) => walk(h, nextCtx));
    }
  }

  (menu || []).forEach((root) => walk(root, {}));
  
  console.log(`[flattenMenuToArticles] ✅ Procesados ${out.length} artículos (${rubrosSkipped} rubros/categorías omitidos)`);
  
  return out;
}

/* ───────── Import completo de menú para un negocio ───────── */
/**
 * Paso central del onboarding de ventas:
 *  - trae el menú desde Maxi,
 *  - llena/actualiza maxi_articles (SOLO artículos, NO rubros),
 *  - llena/actualiza maxi_article_map con external_code + title.
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

  // 2) Aplanar en artículos (SOLO artículos, NO rubros)
  const articles = flattenMenuToArticles(menu);

  if (articles.length === 0) {
    console.warn(`[importMaxiMenuForBusiness] Business ${bizId}: No se encontraron artículos`);
    return {
      ok: true,
      business_id: bizId,
      imported_articles: 0,
    };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 3) maxi_articles: espejo ordenado del menú de Maxi (SOLO artículos)
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

    // 4) maxi_article_map: base para mapping (sin tocar article_id)
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

    await client.query('COMMIT');

    console.log(`[importMaxiMenuForBusiness] ✅ Business ${bizId}: ${articles.length} artículos importados`);

    return {
      ok: true,
      business_id: bizId,
      imported_articles: articles.length,
    };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error(`[importMaxiMenuForBusiness] ❌ Business ${bizId} error:`, e);
    throw e;
  } finally {
    client.release();
  }
}

module.exports = {
  fetchMenu,
  flattenMenuToArticles, 
  importMaxiMenuForBusiness,
};