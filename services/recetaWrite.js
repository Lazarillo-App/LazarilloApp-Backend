// services/recetaWrite.js
//
// Escritura real de una receta (artículo o elaborado) en la DB — ÚNICA fuente
// de verdad, extraída de recetasController.js/recetasElaboradosController.js
// para que el guardado directo (admin/owner) y la aplicación de una propuesta
// aprobada (Fase 3, ver recetaProposalsController.js) compartan exactamente
// el mismo camino en vez de mantener dos copias que puedan divergir.
//
// Cada función hace su propio BEGIN/COMMIT/ROLLBACK (conexión propia) y
// devuelve el resultado — quien la llama decide qué responder por HTTP.
'use strict';

const pool = require('../config/db');
const { propagateRecipe } = require('./linkPropagation');
const { recalcularCostoReceta, propagarCostoInsumo } = require('./costoRecetaService');
const { normalizarCantidadUnidad } = require('./unidades');
const { logAudit } = require('./audit/auditLog');

/**
 * POST /businesses/:businessId/articles/:articleId/receta — lógica real.
 */
async function writeArticleReceta({ bizId, articleId, uid, body }) {
  const client = await pool.connect();
  try {
    const {
      nombre,
      descripcion,
      porciones = 1,
      porcentajeVenta = 0,
      rendimientoUnidad = 'porcion',
      rendimientoPeso = null,
      unidadPeso = null,
      items = [],
      notas,
      foto,
      fotos,
      notasUpdatedAt,
      metodoCoccion = null,
      temperatura = null,
      tiempoMin = null,
      pasos = [],
    } = body || {};

    const pasosArr = Array.isArray(pasos) ? pasos.filter(p => typeof p === 'string' && p.trim()).map(p => p.trim()) : [];
    const pasosJson = JSON.stringify(pasosArr);
    const temperaturaVal = temperatura != null && temperatura !== '' ? Number(temperatura) : null;
    const tiempoMinVal = tiempoMin != null && tiempoMin !== '' ? Number(tiempoMin) : null;
    const metodoCoccionVal = (metodoCoccion || '').trim() || null;

    let fotosArr = Array.isArray(fotos) ? fotos.filter(Boolean).slice(0, 6) : [];
    if (fotosArr.length === 0 && foto) fotosArr = [foto];
    const fotosJson = JSON.stringify(fotosArr);
    const fotoPrincipal = fotosArr[0] || null;

    const VALID_RU = ['porcion', 'u', 'lt', 'ml', 'kg', 'gr'];
    const VALID_UP = ['gr', 'kg', 'ml', 'lt'];
    const ruFinal = VALID_RU.includes(rendimientoUnidad) ? rendimientoUnidad : 'porcion';
    const aplicaPeso = ['porcion', 'u'].includes(ruFinal);
    const rpFinal = aplicaPeso && rendimientoPeso != null && Number(rendimientoPeso) > 0
      ? Number(rendimientoPeso)
      : null;
    const upFinal = aplicaPeso && VALID_UP.includes(unidadPeso) ? unidadPeso : null;

    if (!Array.isArray(items)) {
      const err = new Error('items_must_be_array');
      err.status = 400;
      throw err;
    }

    const costoTotal = items.reduce((acc, item) => {
      const cant = Number(item.cantidad || 0);
      if (cant === 0) return acc;
      return acc + (cant * Number(item.costoUnitario || 0));
    }, 0);

    await client.query('BEGIN');

    const { rows: existing } = await client.query(
      `SELECT id FROM recetas WHERE article_id = $1 AND business_id = $2`,
      [articleId, bizId]
    );

    let recetaRows;
    if (existing.length) {
      const { rows } = await client.query(
        `UPDATE recetas SET
       nombre             = $1,
       descripcion        = $2,
       porciones          = $3,
       porcentaje_venta   = $4,
       costo_total        = $5,
       notas              = $6,
       foto               = $7,
       fotos              = $8::jsonb,
       notas_updated_at   = $9,
       rendimiento_unidad = $10,
       rendimiento_peso   = $11,
       unidad_peso        = $12,
       metodo_coccion     = $14,
       temperatura        = $15,
       tiempo_min         = $16,
       pasos              = $17::jsonb,
       active             = TRUE,
       origen             = 'manual',
       updated_at         = NOW()
     WHERE id = $13
     RETURNING *`,
        [
          nombre?.trim() || null,
          descripcion?.trim() || null,
          Number(porciones) || 1,
          Number(porcentajeVenta) || 0,
          Math.round(costoTotal * 10000) / 10000,
          notas?.trim() || null,
          fotoPrincipal,
          fotosJson,
          notasUpdatedAt || null,
          ruFinal, rpFinal, upFinal,
          existing[0].id,
          metodoCoccionVal, temperaturaVal, tiempoMinVal, pasosJson,
        ]
      );
      recetaRows = rows;
    } else {
      const { rows } = await client.query(
        `INSERT INTO recetas
       (article_id, business_id, nombre, descripcion, porciones,
        porcentaje_venta, costo_total, notas, foto, fotos, notas_updated_at,
        rendimiento_unidad, rendimiento_peso, unidad_peso,
        metodo_coccion, temperatura, tiempo_min, pasos,
        active, origen, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14, $15, $16, $17, $18::jsonb, TRUE, 'manual', NOW(), NOW())
     RETURNING *`,
        [
          articleId, bizId,
          nombre?.trim() || null,
          descripcion?.trim() || null,
          Number(porciones) || 1,
          Number(porcentajeVenta) || 0,
          Math.round(costoTotal * 10000) / 10000,
          notas?.trim() || null,
          fotoPrincipal,
          fotosJson,
          notasUpdatedAt || null,
          ruFinal, rpFinal, upFinal,
          metodoCoccionVal, temperaturaVal, tiempoMinVal, pasosJson,
        ]
      );
      recetaRows = rows;
    }

    const receta = recetaRows[0];
    await client.query(`DELETE FROM receta_items WHERE receta_id = $1`, [receta.id]);

    const savedItems = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const _norm = normalizarCantidadUnidad(
        Number(item.cantidad || 0),
        item.unidad || '',
        Number(item.costoUnitario || 0)
      );
      const cantidad = _norm.cantidad;
      const costoUnitario = _norm.costoUnitario;
      const unidad = _norm.unidad || null;
      const notasItem = (item.notas || '').trim() || null;
      const orden = Number.isFinite(Number(item.orden)) ? Number(item.orden) : i;
      const merma = item.merma !== false;
      const mermaIds = Array.isArray(item.mermaIds)
        ? item.mermaIds.map(Number).filter(Number.isFinite)
        : (item.mermaId != null ? [Number(item.mermaId)] : []);
      const mermaId = mermaIds.length ? mermaIds[0] : null;
      const pedido = item.pedido !== false;
      const secreto = item.secreto === true;
      const tipoCosto = (item.tipoCosto || 'total').trim();
      const observaciones = (item.observaciones || '').trim() || null;
      const fotosUrls = Array.isArray(item.fotosUrls)
        ? item.fotosUrls.filter(u => typeof u === 'string' && u.startsWith('http'))
        : [];

      if (cantidad === 0) continue;

      const articleRefId = Number(item.articleRefId);
      if (Number.isFinite(articleRefId) && articleRefId !== 0) {
        let refNombre = null, refMedida = 'u';
        if (articleRefId > 0) {
          const { rows: aRows } = await client.query(
            `SELECT nombre FROM maxi_articles WHERE business_id = $1 AND articulo_id = $2 LIMIT 1`,
            [bizId, articleRefId]
          );
          refNombre = aRows[0]?.nombre || null;
        } else {
          const { rows: aRows } = await client.query(
            `SELECT nombre FROM app_articles WHERE business_id = $1 AND id = $2 LIMIT 1`,
            [bizId, Math.abs(articleRefId)]
          );
          refNombre = aRows[0]?.nombre || null;
        }

        const { rows: itemRows } = await client.query(
          `INSERT INTO receta_items
             (receta_id, article_ref_id, cantidad, unidad, costo_unitario, notas,
              observaciones, fotos_urls, merma, pedido, tipo_costo, orden,
              nombre_insumo_maxi, merma_id, secreto, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW(), NOW())
           RETURNING *`,
          [
            receta.id, articleRefId, cantidad, unidad, costoUnitario, notasItem,
            observaciones, fotosUrls, merma, pedido, tipoCosto, orden, refNombre, mermaId, secreto,
          ]
        );
        savedItems.push({
          ...itemRows[0],
          article_ref_id: articleRefId,
          supply_nombre: refNombre,
          supply_medida: refMedida,
          costo_total_item: Math.round(cantidad * costoUnitario * 10000) / 10000,
        });
        continue;
      }

      const supplyId = Number(item.supplyId);
      if (!Number.isFinite(supplyId) || supplyId <= 0) continue;
      const { rows: insumoCheck } = await client.query(
        `SELECT id, nombre, unidad_med FROM insumos WHERE id = $1 LIMIT 1`,
        [supplyId]
      );
      if (!insumoCheck.length) {
        console.warn(`[writeArticleReceta] insumo_id=${supplyId} no existe en tabla insumos, ignorando item`);
        continue;
      }
      const { rows: itemRows } = await client.query(
        `INSERT INTO receta_items
           (receta_id, insumo_id, cantidad, unidad, costo_unitario, notas,
            observaciones, fotos_urls, merma, pedido, tipo_costo, orden,
            merma_id, merma_ids, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW(), NOW())
         RETURNING *`,
        [
          receta.id, supplyId, cantidad, unidad, costoUnitario, notasItem,
          observaciones, fotosUrls, merma, pedido, tipoCosto, orden,
          mermaId, mermaIds.length ? mermaIds : null,
        ]
      );
      savedItems.push({
        ...itemRows[0],
        supply_id: supplyId,
        supply_nombre: insumoCheck[0].nombre,
        supply_medida: insumoCheck[0].unidad_med,
        costo_total_item: Math.round(cantidad * costoUnitario * 10000) / 10000,
      });
    }

    const esPromo = items.some(it => {
      const ref = Number(it.articleRefId);
      return Number.isFinite(ref) && ref !== 0;
    });
    await client.query(
      `UPDATE recetas SET es_promo = $1 WHERE id = $2`,
      [esPromo, receta.id]
    );

    const recetaCostos = await recalcularCostoReceta(receta.id, client);
    const costoTotalDB = Number(recetaCostos?.costo_total) || costoTotal;

    const porcentaje = Number(porcentajeVenta) || 0;
    await client.query(
      `UPDATE insumos
       SET costo_receta = $1, precio_ref = $1, tiene_receta = TRUE, updated_at = NOW()
       WHERE id = $2 AND business_id = $3
         AND (es_elaborado = TRUE OR es_elaborado_manual = TRUE)`,
      [Math.round(costoTotalDB * 1000) / 1000, articleId, bizId]
    );

    if (porcentaje > 0) {
      await client.query(
        `INSERT INTO article_price_config
           (business_id, scope, scope_id, objetivo_pct, updated_at)
         VALUES ($1, 'articulo', $2, $3, NOW())
         ON CONFLICT (business_id, scope, scope_id) DO UPDATE SET
           objetivo_pct = EXCLUDED.objetivo_pct,
           updated_at   = NOW()`,
        [bizId, String(articleId), porcentaje]
      );
    }

    // Propuesta aplicada: ya no queda pendiente.
    await client.query(`UPDATE recetas SET has_pending_proposal = FALSE WHERE id = $1`, [receta.id]);

    await logAudit(client, {
      userId: uid, businessId: bizId,
      entityType: 'receta', entityId: articleId,
      action: existing.length ? 'update' : 'create',
      diff: {
        after: {
          nombre: receta.nombre,
          porciones: receta.porciones,
          porcentajeVenta: receta.porcentaje_venta,
          costoTotal: costoTotalDB,
          items: savedItems.length,
        },
      },
    });

    await client.query('COMMIT');

    console.log(`✅ [writeArticleReceta] Receta ID=${receta.id} | Art=${articleId} | Biz=${bizId} | ${savedItems.length} items | Costo=$${costoTotal.toFixed(4)}`);

    propagateRecipe({ bizId, articleId, receta, savedItems }).catch(e =>
      console.warn('[writeArticleReceta] propagateRecipe falló (no crítico):', e.message)
    );

    return { receta, recetaCostos, savedItems, costoTotal };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { }
    throw e;
  } finally {
    client.release();
  }
}

/**
 * POST /businesses/:businessId/insumos/:insumoId/receta — lógica real.
 * `insumo` es la fila ya leída de la tabla insumos (id, nombre, unidad_med,
 * es_elaborado, es_elaborado_manual) — quien llama ya la necesitó para validar.
 */
async function writeElaboradoReceta({ bizId, insumoId, uid, body, insumo }) {
  const client = await pool.connect();
  try {
    if (!insumo.es_elaborado && !insumo.es_elaborado_manual) {
      await client.query(
        `UPDATE insumos SET es_elaborado_manual = TRUE, updated_at = NOW()
     WHERE id = $1 AND business_id = $2`,
        [insumoId, bizId]
      );
    }

    const {
      nombre,
      descripcion,
      porciones = 1,
      porcentajeVenta = 0,
      rendimientoUnidad = 'porcion',
      rendimientoPeso = null,
      unidadPeso = null,
      items = [],
      notas,
      foto,
      fotos,
      notasUpdatedAt,
      metodoCoccion = null,
      temperatura = null,
      tiempoMin = null,
      pasos = [],
    } = body || {};

    const pasosArr = Array.isArray(pasos) ? pasos.filter(p => typeof p === 'string' && p.trim()).map(p => p.trim()) : [];
    const pasosJson = JSON.stringify(pasosArr);
    const temperaturaVal = temperatura != null && temperatura !== '' ? Number(temperatura) : null;
    const tiempoMinVal = tiempoMin != null && tiempoMin !== '' ? Number(tiempoMin) : null;
    const metodoCoccionVal = (metodoCoccion || '').trim() || null;

    if (!Array.isArray(items)) {
      const err = new Error('items_must_be_array');
      err.status = 400;
      throw err;
    }

    let fotosArr = Array.isArray(fotos) ? fotos.filter(Boolean).slice(0, 6) : [];
    if (fotosArr.length === 0 && foto) fotosArr = [foto];
    const fotosJson = JSON.stringify(fotosArr);
    const fotoPrincipal = fotosArr[0] || null;

    const VALID_RU = ['porcion', 'u', 'lt', 'ml', 'kg', 'gr'];
    const VALID_UP = ['gr', 'kg', 'ml', 'lt'];
    const ruFinal = VALID_RU.includes(rendimientoUnidad) ? rendimientoUnidad : 'porcion';
    const aplicaPeso = ['porcion', 'u'].includes(ruFinal);
    const rpRaw = aplicaPeso && rendimientoPeso != null && Number(rendimientoPeso) > 0 ? Number(rendimientoPeso) : null;
    const upRaw = aplicaPeso && VALID_UP.includes(unidadPeso) ? unidadPeso : null;
    const rpFinal = (rpRaw != null && upRaw != null) ? rpRaw : null;
    const upFinal = (rpRaw != null && upRaw != null) ? upRaw : null;

    const costoTotal = items.reduce((acc, item) => {
      const cant = Number(item.cantidad || 0);
      if (cant === 0) return acc;
      return acc + (cant * Number(item.costoUnitario || 0));
    }, 0);

    // Piso mínimo solo para evitar división por cero — NO forzar a 1: cuando
    // rendimientoUnidad es una cantidad física (lt/ml/kg/gr/u) un lote de
    // menos de 1 es perfectamente válido (ej. 0,95 lt), y antes quedaba
    // silenciosamente redondeado hacia arriba a 1 por este Math.max(1, ...).
    const porcionesNum = Math.max(0.001, Number(porciones) || 1);
    const costoXPorcion = costoTotal / porcionesNum;
    let porcentajeNum = Number(porcentajeVenta) || 0;
    if (!porcentajeNum) {
      try {
        const { rows: bizRows } = await client.query(
          `SELECT (props->>'insumos_costo_ideal')::numeric AS pct
             FROM app_businesses WHERE id = $1 LIMIT 1`,
          [bizId]
        );
        porcentajeNum = Number(bizRows[0]?.pct || 30);
      } catch { porcentajeNum = 30; }
    }

    const precioSugerido = porcentajeNum > 0 ? costoXPorcion / (porcentajeNum / 100) : 0;

    await client.query('BEGIN');

    const { rows: existingReceta } = await client.query(
      `SELECT id FROM recetas WHERE insumo_id = $1 AND business_id = $2`,
      [insumoId, bizId]
    );

    const { rows: recetaRows } = await client.query(
      `INSERT INTO recetas
         (insumo_id, business_id, nombre, descripcion, porciones,
          porcentaje_venta, costo_total, notas, foto, fotos, notas_updated_at,
          rendimiento_unidad, rendimiento_peso, unidad_peso,
          metodo_coccion, temperatura, tiempo_min, pasos,
          active, origen, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14, $15, $16, $17, $18::jsonb, TRUE, 'manual', $19, NOW(), NOW())
       ON CONFLICT ON CONSTRAINT recetas_insumo_biz_key
       DO UPDATE SET
         nombre             = EXCLUDED.nombre,
         descripcion        = EXCLUDED.descripcion,
         porciones          = EXCLUDED.porciones,
         porcentaje_venta   = EXCLUDED.porcentaje_venta,
         costo_total        = EXCLUDED.costo_total,
         notas              = EXCLUDED.notas,
         foto               = EXCLUDED.foto,
         fotos              = EXCLUDED.fotos,
         notas_updated_at   = EXCLUDED.notas_updated_at,
         rendimiento_unidad = EXCLUDED.rendimiento_unidad,
         rendimiento_peso   = EXCLUDED.rendimiento_peso,
         unidad_peso        = EXCLUDED.unidad_peso,
         metodo_coccion     = EXCLUDED.metodo_coccion,
         temperatura        = EXCLUDED.temperatura,
         tiempo_min         = EXCLUDED.tiempo_min,
         pasos              = EXCLUDED.pasos,
         active             = TRUE,
         origen             = 'manual',
         updated_at         = NOW()
       RETURNING *`,
      [
        insumoId, bizId,
        nombre?.trim() || insumo.nombre,
        descripcion?.trim() || null,
        porcionesNum,
        porcentajeNum,
        Math.round(costoTotal * 10000) / 10000,
        notas?.trim() || null,
        fotoPrincipal,
        fotosJson,
        notasUpdatedAt || null,
        ruFinal,
        rpFinal,
        upFinal,
        metodoCoccionVal, temperaturaVal, tiempoMinVal, pasosJson,
        uid,
      ]
    );

    const receta = recetaRows[0];

    await client.query(
      `UPDATE insumos SET es_elaborado = TRUE, updated_at = NOW()
        WHERE id = $1 AND business_id = $2 AND es_elaborado IS NOT TRUE`,
      [insumoId, bizId]
    );

    await client.query(`DELETE FROM receta_items WHERE receta_id = $1`, [receta.id]);

    const savedItems = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const supplyId = Number(item.supplyId);
      const _norm = normalizarCantidadUnidad(
        Number(item.cantidad || 0),
        item.unidad || '',
        Number(item.costoUnitario || 0)
      );
      const cantidad = _norm.cantidad;
      const costoUnitario = _norm.costoUnitario;
      const unidad = _norm.unidad || null;
      const notasItem = (item.notas || '').trim() || null;
      const orden = Number.isFinite(Number(item.orden)) ? Number(item.orden) : i;

      if (!Number.isFinite(supplyId) || supplyId <= 0) continue;
      if (cantidad === 0) continue;

      const { rows: insumoCheck } = await client.query(
        `SELECT id, nombre, unidad_med FROM insumos WHERE id = $1 LIMIT 1`,
        [supplyId]
      );
      if (!insumoCheck.length) continue;

      const merma = item.merma !== false;
      const mermaIds = Array.isArray(item.mermaIds)
        ? item.mermaIds.map(Number).filter(Number.isFinite)
        : (item.mermaId != null ? [Number(item.mermaId)] : []);
      const mermaId = mermaIds.length ? mermaIds[0] : null;
      const pedido = item.pedido !== false;
      const secreto = item.secreto === true;
      const tipoCosto = (item.tipoCosto || 'total').trim();
      const observaciones = (item.observaciones || '').trim() || null;
      const fotosUrlsItem = Array.isArray(item.fotosUrls)
        ? item.fotosUrls.filter(u => typeof u === 'string' && u.startsWith('http'))
        : [];

      const { rows: itemRows } = await client.query(
        `INSERT INTO receta_items
           (receta_id, insumo_id, cantidad, unidad, costo_unitario, notas,
            observaciones, fotos_urls, merma, pedido, tipo_costo, orden,
            merma_id, merma_ids, secreto, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW(), NOW())
         RETURNING *`,
        [receta.id, supplyId, cantidad, unidad, costoUnitario, notasItem,
          observaciones, fotosUrlsItem, merma, pedido, tipoCosto, orden,
          mermaId, mermaIds.length ? mermaIds : null, secreto]
      );

      savedItems.push({
        ...itemRows[0],
        supply_id: supplyId,
        supply_nombre: insumoCheck[0].nombre,
        supply_medida: insumoCheck[0].unidad_med,
        costo_total_item: Math.round(cantidad * costoUnitario * 10000) / 10000,
      });
    }

    const recetaCostos = await recalcularCostoReceta(receta.id, client);
    const costoTotalDB    = Number(recetaCostos?.costo_total)    || costoTotal;
    const costoUnitarioDB = Number(recetaCostos?.costo_unitario) || costoXPorcion;

    await client.query(
      `UPDATE insumos
          SET precio_ref   = $1,
              costo_receta = $2,
              tiene_receta = TRUE,
              updated_at   = NOW()
        WHERE id = $3 AND business_id = $4`,
      [
        Math.round(costoUnitarioDB * 1000000) / 1000000,
        Math.round(costoTotalDB    * 1000)    / 1000,
        insumoId, bizId,
      ]
    );

    await propagarCostoInsumo(insumoId, bizId, client);

    const precioSugeridoDB = porcentajeNum > 0 ? costoUnitarioDB / (porcentajeNum / 100) : 0;

    // Propuesta aplicada: ya no queda pendiente.
    await client.query(`UPDATE recetas SET has_pending_proposal = FALSE WHERE id = $1`, [receta.id]);

    await logAudit(client, {
      userId: uid, businessId: bizId,
      entityType: 'receta_elaborado', entityId: insumoId,
      action: existingReceta.length ? 'update' : 'create',
      diff: {
        after: {
          nombre: receta.nombre,
          porciones: porcionesNum,
          porcentajeVenta: porcentajeNum,
          costoTotal: costoTotalDB,
          costoUnitario: costoUnitarioDB,
          items: savedItems.length,
        },
      },
    });

    await client.query('COMMIT');

    const { invalidateCacheForBiz } = require('../middleware/cacheJson');
    invalidateCacheForBiz(bizId);

    console.log(`✅ [writeElaboradoReceta] Insumo=${insumoId} | Biz=${bizId} | Costo/u=$${costoXPorcion.toFixed(4)} | PrecioSug=$${precioSugerido.toFixed(4)}`);

    return {
      receta, recetaCostos, savedItems,
      costoUnitarioDB, precioSugeridoDB, porcionesNum,
    };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { }
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { writeArticleReceta, writeElaboradoReceta };
