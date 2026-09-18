// controllers/recetasBulkController.js
'use strict';

const pool = require('../config/db');
const getBusinessId = require('../utils/getBusinessId');
const { recalcularCostoRecetas } = require('../services/costoRecetaService');

/**
 * Resuelve los article_id de una agrupación leyendo tanto
 * el JSONB `articulos` como el array `app_articles_ids`.
 */
async function getArticleIdsFromAgrupacion(client, bizId, agrupacionId) {
  const { rows } = await client.query(
    `SELECT articulos, app_articles_ids
       FROM agrupaciones
      WHERE id = $1 AND business_id = $2`,
    [agrupacionId, bizId]
  );
  if (!rows.length) return [];

  const ids = new Set();

  // articulos JSONB: array de objetos { id, ... }
  const arts = rows[0].articulos;
  if (Array.isArray(arts)) {
    for (const a of arts) {
      const id = Number(a?.id ?? a?.articulo_id ?? a);
      if (Number.isFinite(id) && id !== 0) ids.add(id);
    }
  }

  // app_articles_ids: array de números
  const appIds = rows[0].app_articles_ids;
  if (Array.isArray(appIds)) {
    for (const raw of appIds) {
      const id = Number(raw);
      if (Number.isFinite(id) && id !== 0) ids.add(id);
    }
  }

  return Array.from(ids);
}

/**
 * Resuelve los insumo_id de un grupo de insumos.
 */
async function getInsumoIdsFromGroup(client, bizId, groupId) {
  const { rows } = await client.query(
    `SELECT gi.insumo_id
       FROM insumo_group_items gi
       JOIN insumo_groups g ON g.id = gi.group_id
      WHERE g.id = $1 AND g.business_id = $2`,
    [groupId, bizId]
  );
  return rows.map(r => Number(r.insumo_id)).filter(n => Number.isFinite(n) && n !== 0);
}

/**
 * GET /api/businesses/:businessId/recetas/bulk-preview
 * Query: ?tipo=articulo|elaborado&filtroScope=all|agrupacion&agrupacionId=N
 * Devuelve { count } para mostrar en el modal antes de confirmar.
 */
exports.previewBulkDelete = async (req, res, next) => {
  const client = await pool.connect();
  try {
    const bizId = Number(req.params.businessId) || getBusinessId(req);
    if (!bizId) return res.status(400).json({ ok: false, error: 'Business ID requerido' });

    const { tipo, filtroScope = 'all', agrupacionId } = req.query;
    if (!['articulo', 'elaborado'].includes(tipo)) {
      return res.status(400).json({ ok: false, error: 'tipo_invalido' });
    }

    const conditions = [`business_id = $1`, `active = TRUE`];
    const params = [bizId];

    if (tipo === 'articulo') {
      conditions.push(`article_id IS NOT NULL`);
    } else {
      conditions.push(`insumo_id IS NOT NULL`);
    }

    if (filtroScope === 'agrupacion') {
      const agrupId = Number(agrupacionId);
      if (!Number.isFinite(agrupId)) {
        return res.status(400).json({ ok: false, error: 'agrupacion_id_requerido' });
      }

      let ids;
      if (tipo === 'articulo') {
        ids = await getArticleIdsFromAgrupacion(client, bizId, agrupId);
        if (!ids.length) return res.json({ ok: true, count: 0 });
        params.push(ids);
        conditions.push(`article_id = ANY($${params.length}::int[])`);
      } else {
        ids = await getInsumoIdsFromGroup(client, bizId, agrupId);
        if (!ids.length) return res.json({ ok: true, count: 0 });
        params.push(ids);
        conditions.push(`insumo_id = ANY($${params.length}::int[])`);
      }
    }

    const { rows } = await client.query(
      `SELECT COUNT(*)::int AS count
         FROM recetas
        WHERE ${conditions.join(' AND ')}`,
      params
    );

    return res.json({ ok: true, count: rows[0].count });
  } catch (e) {
    console.error('[previewBulkDelete]', e);
    next(e);
  } finally {
    client.release();
  }
};

/**
 * DELETE /api/businesses/:businessId/recetas/bulk
 * Body: { tipo, filtroScope, agrupacionId? }
 */
exports.bulkDelete = async (req, res, next) => {
  const client = await pool.connect();
  try {
    const bizId = getBusinessId(req);
    if (!bizId) return res.status(400).json({ ok: false, error: 'business_id_requerido' });

    const { tipo, filtroScope = 'all', agrupacionId } = req.body || {};
    if (!['articulo', 'elaborado'].includes(tipo)) {
      return res.status(400).json({ ok: false, error: 'tipo_invalido' });
    }

    await client.query('BEGIN');

    const conditions = [`business_id = $1`];
    const params = [bizId];

    if (tipo === 'articulo') {
      conditions.push(`article_id IS NOT NULL`);
    } else {
      conditions.push(`insumo_id IS NOT NULL`);
    }

    if (filtroScope === 'agrupacion') {
      const agrupId = Number(agrupacionId);
      if (!Number.isFinite(agrupId)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ ok: false, error: 'agrupacion_id_requerido' });
      }

      let ids;
      if (tipo === 'articulo') {
        ids = await getArticleIdsFromAgrupacion(client, bizId, agrupId);
      } else {
        ids = await getInsumoIdsFromGroup(client, bizId, agrupId);
      }

      if (!ids.length) {
        await client.query('COMMIT');
        return res.json({ ok: true, deleted: 0 });
      }

      params.push(ids);
      conditions.push(
        tipo === 'articulo'
          ? `article_id = ANY($${params.length}::int[])`
          : `insumo_id = ANY($${params.length}::int[])`
      );
    }

    const { rowCount } = await client.query(
      `DELETE FROM recetas WHERE ${conditions.join(' AND ')}`,
      params
    );

    await client.query('COMMIT');
    console.log(`[recetas/bulk] business=${bizId} tipo=${tipo} scope=${filtroScope} deleted=${rowCount}`);

    return res.json({ ok: true, deleted: rowCount });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { }
    console.error('[bulkDelete]', e);
    next(e);
  } finally {
    client.release();
  }
};

/**
 * POST /api/businesses/:businessId/recetas/bulk-add-insumo
 * Body: { articleIds: number[], insumoId: number, cantidad: number, unidad: string }
 *
 * Agrega (o actualiza) un insumo en las recetas de todos los artículos indicados:
 * - Si el artículo tiene receta activa y NO tiene el insumo → agrega el item.
 * - Si ya tiene el insumo → actualiza cantidad/unidad/costo_unitario del item existente
 *   (permite corregir en bloque un insumo ya cargado en algunas o todas las recetas).
 * - Si no tiene receta → crea una receta mínima con ese único item.
 * Recalcula costo_total de cada receta tocada.
 */
exports.bulkAddInsumo = async (req, res, next) => {
  const bizId = Number(req.params.businessId) || getBusinessId(req);
  if (!bizId) return res.status(400).json({ ok: false, error: 'Business ID requerido' });

  const { articleIds, insumoId, cantidad = 0, unidad = null } = req.body || {};
  const ids = (Array.isArray(articleIds) ? articleIds : [])
    .map(Number).filter(n => Number.isFinite(n) && n !== 0);
  const insId = Number(insumoId);

  if (!ids.length) return res.status(400).json({ ok: false, error: 'articleIds requerido' });
  if (!Number.isFinite(insId) || insId === 0) {
    return res.status(400).json({ ok: false, error: 'insumoId requerido' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Datos del insumo (precio y unidad base para costo_unitario)
    const { rows: insRows } = await client.query(
      `SELECT id, nombre, unidad_med, precio_ref, codigo_maxi, contenido_envase, unidad_envase
         FROM insumos
        WHERE id = $1 AND business_id = $2`,
      [insId, bizId]
    );
    if (!insRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'Insumo no encontrado' });
    }
    const insumo = insRows[0];

    // Equivalencias propias del insumo (mismas que usa RecetaModal) — permiten elegir
    // una unidad "nombrada" (ej. "Sobre", "Media oz") además de las unidades físicas.
    const { rows: eqRows } = await client.query(
      `SELECT nombre, contenido, unidad FROM insumo_equivalencias WHERE insumo_id = $1`,
      [insId]
    );

    // Conversión de unidades físicas — mismo criterio que src/componentes/RecetaModal/helpers.js
    // (canonicalUnit + getConversionFactor), para que "elegir la misma unidad que en la receta"
    // dé el mismo costo acá y allá.
    const UNIT_ALIASES = {
      g: 'gr', gr: 'gr', grs: 'gr', gramo: 'gr', gramos: 'gr',
      k: 'kg', kg: 'kg', kgs: 'kg', kilo: 'kg', kilos: 'kg', kilogramo: 'kg', kilogramos: 'kg',
      ml: 'ml', mls: 'ml', cc: 'ml', mililitro: 'ml', mililitros: 'ml',
      l: 'lt', lt: 'lt', lts: 'lt', litro: 'lt', litros: 'lt',
      u: 'u', un: 'u', uni: 'u', unid: 'u', unidad: 'u', unidades: 'u', und: 'u', doc: 'u', docena: 'u',
      oz: 'oz', onza: 'oz', onzas: 'oz', lb: 'lb', libra: 'lb', libras: 'lb',
    };
    const canonicalUnit = (u) => {
      const n = String(u || 'u').toLowerCase().trim();
      return UNIT_ALIASES[n] || n;
    };
    const getConversionFactor = (from, to) => {
      // "oz" acá es SIEMPRE onza fluida (volumen) — nunca onza de peso. No va en PESO.
      const PESO = { gr: 1, kg: 1000, lb: 453.59 };
      const VOLUM = { ml: 1, lt: 1000, oz: 30 };
      const f = canonicalUnit(from), t = canonicalUnit(to);
      if (f === t) return 1;
      if (PESO[f] !== undefined && PESO[t] !== undefined) return PESO[f] / PESO[t];
      if (VOLUM[f] !== undefined && VOLUM[t] !== undefined) return VOLUM[f] / VOLUM[t];
      return 1; // unidades incompatibles (o discretas, ej. "u"): sin conversión
    };

    const unidadItem = unidad || insumo.unidad_med || 'u';
    const precioRef = Number(insumo.precio_ref) || 0;
    const unidadDB = canonicalUnit(insumo.unidad_med || 'u');
    const contEnvase = Number(insumo.contenido_envase) || 0;
    const uniEnvase = canonicalUnit(insumo.unidad_envase || '');

    // ¿La unidad elegida es una equivalencia propia del insumo? (match case-insensitive
    // por nombre, igual que eqNombreMatch en RecetaModal/calcCosto.js)
    const eqSel = eqRows.find(e => String(e.nombre || '').trim().toLowerCase() === String(unidadItem).trim().toLowerCase());

    let costoUnitario;
    if (eqSel) {
      const contenido = Number(eqSel.contenido) || 0;
      const eqUnidad = canonicalUnit(eqSel.unidad);
      if (unidadDB === 'u' && contEnvase > 0 && uniEnvase) {
        const costoPorUnidadEnvase = precioRef / contEnvase;
        const factor = getConversionFactor(eqUnidad, uniEnvase);
        costoUnitario = contenido * factor * costoPorUnidadEnvase;
      } else {
        const factor = getConversionFactor(eqUnidad, unidadDB);
        costoUnitario = contenido * factor * precioRef;
      }
    } else {
      const unidadElegida = canonicalUnit(unidadItem);
      if (unidadDB === 'u' && contEnvase > 0 && uniEnvase && unidadElegida !== 'u') {
        const costoPorUnidadEnvase = precioRef / contEnvase;
        const factor = getConversionFactor(unidadElegida, uniEnvase);
        costoUnitario = factor * costoPorUnidadEnvase;
      } else {
        const factor = getConversionFactor(unidadDB, unidadElegida);
        costoUnitario = factor > 0 ? precioRef / factor : precioRef;
      }
    }

    const cant = Number(cantidad) || 0;

    let agregados = 0, actualizados = 0, recetasCreadas = 0;
    const recetasTocadas = [];

    for (const artId of ids) {
      // Buscar receta del artículo SIN filtrar por active (el unique es solo por article+business)
      const { rows: recRows } = await client.query(
        `SELECT id, active FROM recetas
          WHERE article_id = $1 AND business_id = $2
          LIMIT 1`,
        [artId, bizId]
      );
      let recetaId;
      if (recRows.length) {
        recetaId = recRows[0].id;
        // Si estaba inactiva, reactivarla (equivale a "recrear" sin violar el unique)
        if (recRows[0].active !== true) {
          await client.query(
            `UPDATE recetas SET active = TRUE, origen = 'bulk', updated_at = NOW() WHERE id = $1`,
            [recetaId]
          );
          recetasCreadas++;
        } else {
          // Ya activa: ¿ya tiene el insumo? Si sí, actualizar cantidad/unidad/costo en vez de duplicar.
          const { rows: existRows } = await client.query(
            `SELECT id FROM receta_items WHERE receta_id = $1 AND insumo_id = $2 LIMIT 1`,
            [recetaId, insId]
          );
          if (existRows.length) {
            await client.query(
              `UPDATE receta_items
                  SET cantidad = $1, unidad = $2, costo_unitario = $3, updated_at = NOW()
                WHERE id = $4`,
              [cant, unidadItem, Math.round(costoUnitario * 10000) / 10000, existRows[0].id]
            );
            recetasTocadas.push(recetaId);
            actualizados++;
            continue;
          }
        }
      } else {
        // No existe ninguna receta → crear
        const newRec = await client.query(
          `INSERT INTO recetas
             (article_id, business_id, nombre, porciones, porcentaje_venta,
              costo_total, active, origen, created_at, updated_at)
           VALUES ($1, $2, NULL, 1, 0, 0, TRUE, 'bulk', NOW(), NOW())
           RETURNING id`,
          [artId, bizId]
        );
        if (!newRec?.rows?.length) {
          throw new Error(`INSERT receta falló para article_id=${artId}`);
        }
        recetaId = newRec.rows[0].id;
        recetasCreadas++;
      }

      // Insertar item al final
      await client.query(
        `INSERT INTO receta_items
           (receta_id, insumo_id, cantidad, unidad, costo_unitario,
            codigo_maxi_insumo, nombre_insumo_maxi, tipo_costo, merma, pedido, orden)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'total', TRUE, TRUE,
           COALESCE((SELECT MAX(orden) + 1 FROM receta_items WHERE receta_id = $1), 0))`,
        [recetaId, insId, cant, unidadItem,
          Math.round(costoUnitario * 10000) / 10000,
          insumo.codigo_maxi || null, insumo.nombre || null]
      );

      // El costo se materializa después del loop, con el service único
      recetasTocadas.push(recetaId);
      agregados++;
    }

    // ── Materializar costos de todas las recetas tocadas ──
    await recalcularCostoRecetas(recetasTocadas, client);

    await client.query('COMMIT');
    return res.json({ ok: true, agregados, actualizados, recetasCreadas, insumo: insumo.nombre });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[bulkAddInsumo]', e);
    next(e);
  } finally {
    client.release();
  }
}

/**
 * POST /api/businesses/:businessId/recetas/insumos-usados
 * Body: { articleIds: number[] }
 * Devuelve los insumos ya presentes en las recetas de esos artículos,
 * con en_cuantos (en cuántos aparece) y total (tamaño del bloque).
 */
exports.insumosUsadosEnBloque = async (req, res, next) => {
  const bizId = Number(req.params.businessId) || getBusinessId(req);
  if (!bizId) return res.status(400).json({ ok: false, error: 'Business ID requerido' });
  const articleIds = Array.isArray(req.body?.articleIds)
    ? req.body.articleIds.map(Number).filter(Number.isFinite)
    : [];
  if (!articleIds.length) return res.json({ ok: true, data: [], total: 0 });
  try {
    const { rows } = await pool.query(
      `SELECT ri.insumo_id,
              i.nombre,
              i.unidad_med,
              i.precio_ref,
              COUNT(DISTINCT r.article_id)::int AS en_cuantos,
              jsonb_agg(DISTINCT jsonb_build_object('id', r.article_id, 'nombre', ma.nombre)) AS articulos
         FROM recetas r
         JOIN receta_items ri ON ri.receta_id = r.id
         JOIN insumos i ON i.id = ri.insumo_id
         LEFT JOIN maxi_articles ma ON ma.business_id = r.business_id AND ma.articulo_id = r.article_id
        WHERE r.business_id = $1
          AND r.article_id = ANY($2::int[])
          AND ri.insumo_id IS NOT NULL
        GROUP BY ri.insumo_id, i.nombre, i.unidad_med, i.precio_ref
        ORDER BY en_cuantos DESC, i.nombre ASC`,
      [bizId, articleIds]
    );
    return res.json({ ok: true, data: rows, total: articleIds.length });
  } catch (e) {
    console.error('[insumosUsadosEnBloque]', e);
    next(e);
  }
};

/**
 * GET /api/businesses/:businessId/recetas/promo-components
 * Devuelve los article_ref_id que son componentes de alguna promo activa.
 * Estos artículos NO deben mostrarse como filas propias (están dentro de la promo).
 */
exports.getPromoComponents = async (req, res, next) => {
  const bizId = Number(req.params.businessId) || getBusinessId(req);
  if (!bizId) return res.status(400).json({ ok: false, error: 'Business ID requerido' });
  try {
    // Solo se ocultan los componentes que TAMBIÉN viven en la agrupación "Promociones".
    // Un componente que vive en otra agrupación (ej. Cafetería) NO se oculta: se sigue
    // viendo en su origen y además aparece dentro de la promo (modelo "como insumo").
    const { rows } = await pool.query(
      `WITH comps AS (
         SELECT DISTINCT ri.article_ref_id AS id
           FROM receta_items ri
           JOIN recetas r ON r.id = ri.receta_id
          WHERE r.business_id = $1
            AND r.es_promo = TRUE
            AND r.active = TRUE
            AND ri.article_ref_id IS NOT NULL
       ),
       promo_group_ids AS (
         SELECT (art->>'id')::int AS id
           FROM agrupaciones a,
                jsonb_array_elements(COALESCE(a.articulos, '[]'::jsonb)) AS art
          WHERE a.business_id = $1
            AND a.nombre ILIKE 'Promociones'
       )
       SELECT c.id AS article_ref_id
         FROM comps c
        WHERE c.id IN (SELECT id FROM promo_group_ids)`,
      [bizId]
    );
    const ids = rows.map(r => Number(r.article_ref_id)).filter(Number.isFinite);
    return res.json({ ok: true, ids });
  } catch (e) {
    console.error('[getPromoComponents]', e);
    next(e);
  }
};

// GET /api/businesses/:businessId/recetas/promo-ids
// Devuelve los IDs de artículos que SON promos (dueños de una receta es_promo=true).
exports.getPromoIds = async (req, res, next) => {
  const bizId = Number(req.params.businessId) || getBusinessId(req);
  if (!bizId) return res.status(400).json({ ok: false, error: 'Business ID requerido' });
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT r.article_id
         FROM recetas r
        WHERE r.business_id = $1 AND r.es_promo = TRUE AND r.active = TRUE
          AND r.article_id IS NOT NULL`,
      [bizId]
    );
    const ids = rows.map(r => Number(r.article_id)).filter(Number.isFinite);
    return res.json({ ok: true, ids });
  } catch (e) {
    console.error('[getPromoIds]', e);
    next(e);
  }
};

// GET /api/businesses/:businessId/recetas/venta-sin-promo
// Por cada promo (receta es_promo=true), suma (precio_sin_promo × cantidad) de sus componentes.
// precio_sin_promo = precio_manual de la lista principal (list_id NULL) si existe, sino el precio del artículo.
exports.getVentaSinPromo = async (req, res, next) => {
  const bizId = Number(req.params.businessId) || getBusinessId(req);
  if (!bizId) return res.status(400).json({ ok: false, error: 'Business ID requerido' });
  try {
    const { rows } = await pool.query(
      `SELECT r.article_id AS promo_id,
              COALESCE(SUM(
                COALESCE(
                  NULLIF(cfg.precio_manual, 0),      -- nuevo precio de lista principal
                  ma.precio,                          -- precio del artículo maxi
                  aa.price,                           -- precio del artículo app (manual)
                  0
                ) * ri.cantidad
              ), 0) AS venta_sin_promo
         FROM recetas r
         JOIN receta_items ri ON ri.receta_id = r.id
         LEFT JOIN article_price_config cfg
                ON cfg.business_id = r.business_id
               AND cfg.scope = 'articulo'
               AND cfg.scope_id = ri.article_ref_id::text
               AND cfg.list_id IS NULL
         LEFT JOIN maxi_articles ma
                ON ma.business_id = r.business_id
               AND ma.articulo_id = ri.article_ref_id
         LEFT JOIN app_articles aa
                ON aa.business_id = r.business_id
               AND aa.id = ABS(ri.article_ref_id)
        WHERE r.business_id = $1
          AND r.es_promo = TRUE
          AND r.active = TRUE
          AND ri.article_ref_id IS NOT NULL
        GROUP BY r.article_id`,
      [bizId]
    );
    const map = {};
    for (const row of rows) {
      map[Number(row.promo_id)] = Number(row.venta_sin_promo) || 0;
    }
    return res.json({ ok: true, ventaSinPromo: map });
  } catch (e) {
    console.error('[getVentaSinPromo]', e);
    next(e);
  }
};