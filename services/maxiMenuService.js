// services/maxiMenuService.js - VERSIÓN ADITIVA CON FALLBACK
// La sync de artículos NO actualiza datos existentes.
// Solo inserta nuevos. Esto protege ediciones manuales del usuario.
const fetch = require('node-fetch');
const { getBearer } = require('./maxiSalesService');
const pool = require('../config/db');

const MAXI_BASE = process.env.MAXI_BASE_URL || 'https://api-mconn.maxisistemas.com.ar';

/* ───────── URL helpers ───────── */

function buildMenuUrl(base, { listmode, list, id_tienda }) {
  const u = new URL(`${base.replace(/\/+$/, '')}/menuweb/menuextendido`);
  if (listmode)  u.searchParams.set('listmode', listmode);
  if (list)      u.searchParams.set('list', String(list));
  if (id_tienda) u.searchParams.set('id_tienda', String(id_tienda));
  return u.toString();
}

function buildFallbackUrl({ listmode, list, id_tienda }) {
  const u = new URL('https://api-mconn.maxisistemas.com.ar/estadisticasmaster/articulos');
  if (listmode)  u.searchParams.set('listmode', listmode);
  if (list)      u.searchParams.set('list', String(list));
  if (id_tienda) u.searchParams.set('id_tienda', String(id_tienda));
  return u.toString();
}

/* ───────── Helper interno: intenta un fetch, devuelve content o null si falla ───────── */

async function tryFetch(url, headers) {
  try {
    const r = await fetch(url, { headers });
    const txt = await r.text().catch(() => '');
    let j;
    try { j = JSON.parse(txt); } catch {}

    if (!r.ok || j?.resultCode !== 'SUCCESS') {
      console.warn(`[tryFetch] ❌ ${url} → ${r.status} ${j?.resultDescription || r.statusText}`);
      return null;
    }

    return j?.content || [];
  } catch (err) {
    console.warn(`[tryFetch] ❌ ${url} → ${err.message}`);
    return null;
  }
}

/* ───────── Fetch del menú con fallback automático ───────── */

async function fetchMenu({ businessId, req, listmode, list, id_tienda }) {
  const bearer = await getBearer(businessId, req);
  const headers = {
    Authorization: `Bearer ${bearer}`,
    Accept: 'application/json',
  };

  // Intentar endpoint principal
  const primaryUrl = buildMenuUrl(MAXI_BASE, { listmode, list, id_tienda });
  let content = await tryFetch(primaryUrl, headers);

  if (content !== null) {
    console.log(`[fetchMenu] ✅ Business ${businessId}: datos desde endpoint principal`);
    return { content, source: 'primary' };
  }

  // Fallback al segundo endpoint
  console.warn(`[fetchMenu] ⚠️ Business ${businessId}: endpoint principal falló, intentando fallback...`);
  const fallbackUrl = buildFallbackUrl({ listmode, list, id_tienda });
  content = await tryFetch(fallbackUrl, headers);

  if (content !== null) {
    console.log(`[fetchMenu] ✅ Business ${businessId}: datos desde endpoint fallback`);
    return { content, source: 'fallback' };
  }

  // Ambos fallaron
  const e = new Error('Ambos endpoints de Maxi fallaron');
  e.status = 502;
  throw e;
}

/* ───────── Parser del endpoint principal (menuweb/menuextendido) ───────── */
/**
 * Convierte el árbol devuelto por /menuweb/menuextendido
 * en una lista plana de artículos.
 * Solo agrega nodos con node_type === 'ARTICULO'
 */
function flattenMenuToArticles(menu) {
  const out = [];
  let rubrosSkipped = 0;

  function walk(node, ctx) {
    if (!node || typeof node !== 'object') return;

    const nodeType = String(node.node_type || node.type || '').toUpperCase();
    const nombre = node.nombre || node.name || node.title || null;

    let nextCtx = { ...ctx };

    if (nodeType === 'RUBRO' || nodeType === 'CATEGORIA') {
      if (nombre) nextCtx.categoria = nombre;
      rubrosSkipped++;
    }

    if (nodeType === 'SUBRUBRO') {
      if (nombre) nextCtx.subrubro = nombre;
      rubrosSkipped++;
    }

    if (nodeType === 'ARTICULO') {
      const rawId = node.id ?? node.articulo_id ?? node.codigo ?? node.code;
      const articuloId = Number(rawId);

      if (!Number.isFinite(articuloId) || articuloId <= 0) {
        console.warn('[flattenMenuToArticles] Artículo sin ID válido:', { nombre, rawId });
        const hijos = node.hijos || node.children || [];
        if (Array.isArray(hijos)) hijos.forEach((h) => walk(h, nextCtx));
        return;
      }

      const precio = Number(node.precio ?? node.price ?? 0) || 0;
      const costo  = Number(node.costo ?? node.cost ?? 0) || 0;

      if (precio === 0 && nombre && nextCtx.categoria === nombre) {
        console.warn('[flattenMenuToArticles] Posible rubro detectado por heurística:', {
          articulo_id: articuloId, nombre, categoria: nextCtx.categoria
        });
        rubrosSkipped++;
        const hijos = node.hijos || node.children || [];
        if (Array.isArray(hijos)) hijos.forEach((h) => walk(h, nextCtx));
        return;
      }

      out.push({
        articulo_id: articuloId,
        nombre: nombre || `ART-${articuloId}`,
        categoria: nextCtx.categoria || null,
        subrubro: nextCtx.subrubro || null,
        cod_rua: null,
        cod_sua: null,
        precio,
        costo,
        raw: node,
      });

      const hijos = node.hijos || node.children || [];
      if (Array.isArray(hijos) && hijos.length > 0) {
        console.warn('[flattenMenuToArticles] Artículo con hijos (inusual):', articuloId);
        hijos.forEach((h) => walk(h, nextCtx));
      }
      return;
    }

    const hijos = node.hijos || node.children || [];
    if (Array.isArray(hijos)) hijos.forEach((h) => walk(h, nextCtx));
  }

  (menu || []).forEach((root) => walk(root, {}));

  console.log(`[flattenMenuToArticles] ✅ Procesados ${out.length} artículos (${rubrosSkipped} rubros/categorías omitidos)`);

  return out;
}

/* ───────── Parser del endpoint fallback (estadisticasmaster/articulos) ───────── */
/**
 * El fallback devuelve una lista plana sin nombres de rubro/subrubro,
 * solo códigos (cod_rua, cod_sua). Se guardan para poder resolver nombres
 * cuando el endpoint principal vuelva a funcionar.
 */
function flattenFallbackToArticles(content) {
  if (!Array.isArray(content)) return [];

  const out = content
    .filter(a => a?.codigo && !a?.borrado)
    .map(a => ({
      articulo_id: Number(a.codigo),
      nombre: a.nombre || `ART-${a.codigo}`,
      categoria: null,        // no disponible en fallback
      subrubro: null,         // no disponible en fallback
      cod_rua: a.cod_rua || null,
      cod_sua: a.cod_sua || null,
      precio: Number(a.precio1 ?? 0) || 0,
      costo: Number(a.costo ?? 0) || 0,
      raw: a,
    }));

  console.log(`[flattenFallbackToArticles] ✅ Procesados ${out.length} artículos desde fallback`);

  return out;
}

/* ───────── Import completo de menú para un negocio ───────── */
/**
 * SYNC ADITIVA:
 *  - trae el menú desde Maxi (con fallback automático)
 *  - SOLO inserta artículos nuevos (ON CONFLICT DO NOTHING)
 *  - NO actualiza nombre, categoria, subrubro, precio, costo de artículos existentes
 *  - Esto protege ediciones manuales y precios actualizados por el usuario
 *
 *  Guards defensivos:
 *  - Si MaxiRest devuelve 0 artículos, aborta sin tocar la DB
 *
 *  Requiere en maxi_articles:
 *  ALTER TABLE maxi_articles ADD COLUMN IF NOT EXISTS cod_rua INTEGER;
 *  ALTER TABLE maxi_articles ADD COLUMN IF NOT EXISTS cod_sua INTEGER;
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

  // 1) Traer menú crudo desde Maxi (con fallback automático)
  const { content, source } = await fetchMenu({ businessId: bizId, req, listmode, list, id_tienda });

  // 2) Aplanar según la fuente
  const articles = source === 'fallback'
    ? flattenFallbackToArticles(content)
    : flattenMenuToArticles(content);

  console.log(`[importMaxiMenuForBusiness] source=${source}, artículos parseados: ${articles.length}`);

  // ── Guard: si MaxiRest no devolvió nada, no tocar la DB ──
  if (articles.length === 0) {
    console.warn(`[importMaxiMenuForBusiness] Business ${bizId}: MaxiRest devolvió 0 artículos. Sync abortada.`);
    return {
      ok: true,
      business_id: bizId,
      source,
      imported_articles: 0,
      skipped: true,
      message: 'MaxiRest devolvió 0 artículos — sync abortada para proteger datos',
    };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 3) maxi_articles: ADITIVO — solo inserta nuevos, no toca existentes
    const values = [];
    const params = [];
    let i = 1;

    for (const a of articles) {
      values.push(
        `($${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++})`
      );
      params.push(
        bizId,
        a.articulo_id,
        a.nombre,
        a.categoria || null,
        a.subrubro || null,
        a.precio,
        a.costo,
        JSON.stringify(a.raw),
        a.cod_rua || null,
        a.cod_sua || null,
      );
    }

    const insertedRes = await client.query(
      `INSERT INTO maxi_articles (
         business_id, articulo_id, nombre, categoria, subrubro,
         precio, costo, raw, cod_rua, cod_sua
       )
       VALUES ${values.join(', ')}
       ON CONFLICT (business_id, articulo_id) DO NOTHING
       RETURNING articulo_id`,
      params
    );

    const insertedIds = new Set(insertedRes.rows.map(r => Number(r.articulo_id)));

    // 4) maxi_article_map: ADITIVO también — solo crear mappings nuevos
    const values2 = [];
    const params2 = [];
    let j = 1;

    for (const a of articles) {
      values2.push(
        `($${j++}, $${j++}, $${j++}, $${j++}, now(), $${j++}, $${j++})`
      );
      params2.push(
        bizId,
        a.articulo_id,
        a.categoria || null,
        a.subrubro || null,
        String(a.articulo_id),
        a.nombre,
      );
    }

    await client.query(
      `INSERT INTO maxi_article_map (
         business_id, articulo_id, categoria, subrubro,
         updated_at, external_code, title
       )
       VALUES ${values2.join(', ')}
       ON CONFLICT (business_id, articulo_id) DO NOTHING`,
      params2
    );

    await client.query('COMMIT');

    const insertedCount = insertedIds.size;
    const unchangedCount = articles.length - insertedCount;

    console.log(
      `[importMaxiMenuForBusiness] ✅ Business ${bizId}: ` +
      `source=${source} | ${insertedCount} nuevos artículos importados, ${unchangedCount} ya existían (no tocados)`
    );

    return {
      ok: true,
      business_id: bizId,
      source,
      imported_articles: insertedCount,
      unchanged: unchangedCount,
      total_in_maxi: articles.length,
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
  flattenFallbackToArticles,
  importMaxiMenuForBusiness,
};