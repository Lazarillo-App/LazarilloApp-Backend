// services/maxiMenuService.js - VERSIÓN ADITIVA
// La sync de artículos NO actualiza datos existentes.
// Solo inserta nuevos. Esto protege ediciones manuales del usuario.
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

/* ───────── Import completo de menú para un negocio ───────── */
/**
 * SYNC ADITIVA:
 *  - trae el menú desde Maxi
 *  - SOLO inserta artículos nuevos (ON CONFLICT DO NOTHING)
 *  - NO actualiza nombre, categoria, subrubro, precio, costo de artículos existentes
 *  - Esto protege ediciones manuales y precios actualizados por el usuario
 *
 *  Guards defensivos:
 *  - Si MaxiRest devuelve 0 artículos, aborta sin tocar la DB
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

  // 2) Aplanar
  const articles = flattenMenuToArticles(menu);

  // ── Guard: si MaxiRest no devolvió nada, no tocar la DB ──
  if (articles.length === 0) {
    console.warn(`[importMaxiMenuForBusiness] Business ${bizId}: MaxiRest devolvió 0 artículos. Sync abortada.`);
    return {
      ok: true,
      business_id: bizId,
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
        `($${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++})`
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
      );
    }

    const insertedRes = await client.query(
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
      ON CONFLICT (business_id, articulo_id) DO NOTHING
      RETURNING articulo_id
      `,
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
      ON CONFLICT (business_id, articulo_id) DO NOTHING
      `,
      params2
    );

    await client.query('COMMIT');

    const insertedCount = insertedIds.size;
    const unchangedCount = articles.length - insertedCount;

    console.log(
      `[importMaxiMenuForBusiness] ✅ Business ${bizId}: ` +
      `${insertedCount} nuevos artículos importados, ${unchangedCount} ya existían (no tocados)`
    );

    return {
      ok: true,
      business_id: bizId,
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
  importMaxiMenuForBusiness,
};