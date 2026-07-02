// controllers/promocionesController.js
// Creación de promociones (v1).
// Una promo es un artículo nuevo (ID negativo, SKU L00X) cuya receta contiene
// otros artículos (article_ref_id). Hereda el rubro del primer componente.
// Los artículos componentes se ocultan de la tabla vía el endpoint promo-components.
'use strict';
const pool = require('../config/db');
const { invalidateCacheForBiz } = require('../middleware/cacheJson');

function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Igual que en articulosABMController: el storage real de artículos
// para subnegocios es el principal de la organización.
async function resolveStorageBizId(bizId) {
  const { rows } = await pool.query(
    `SELECT organization_id FROM app_businesses WHERE id = $1`, [bizId]
  );
  if (!rows[0]?.organization_id) return bizId;
  const { rows: pRows } = await pool.query(
    `SELECT id FROM app_businesses
      WHERE organization_id = $1 AND created_from != 'from_group'
      ORDER BY created_at ASC LIMIT 1`,
    [rows[0].organization_id]
  );
  return pRows[0]?.id ? Number(pRows[0].id) : bizId;
}

/**
 * Resuelve nombre + rubro (categoria/subrubro) de un artículo por su ID lógico.
 * Positivo → maxi_articles.articulo_id ; Negativo → app_articles.id
 */
async function resolveArticuloInfo(client, storageBizId, artId) {
  if (artId > 0) {
    const { rows } = await client.query(
      `SELECT nombre, categoria, subrubro, precio, costo
         FROM maxi_articles
        WHERE business_id = $1 AND articulo_id = $2 LIMIT 1`,
      [storageBizId, artId]
    );
    if (rows.length) return rows[0];
  } else {
    const { rows } = await client.query(
      `SELECT name AS nombre, rubro AS categoria, subrubro, price AS precio, 0 AS costo
         FROM app_articles
        WHERE business_id = $1 AND id = $2 LIMIT 1`,
      [storageBizId, Math.abs(artId)]
    );
    if (rows.length) return rows[0];
  }
  return null;
}

/**
 * POST /api/businesses/:businessId/promociones
 * Body: {
 *   nombre?: string,                       // opcional; si no viene, se concatena de los componentes
 *   componentes: [{ articleId, cantidad, unidad }, ...],  // artículos que arman la promo
 *   insumos?: [{ insumoId, cantidad, unidad }, ...],      // insumos propios (packaging, etc.)
 *   porcentajeVenta?: number
 * }
 */
exports.crearPromocion = async (req, res, next) => {
  const bizId = Number(req.params.businessId);
  if (!Number.isFinite(bizId)) {
    return res.status(400).json({ ok: false, error: 'businessId inválido' });
  }
  const uid = req.user?.id || null;

  const {
    nombre: nombreManual,
    componentes = [],
    insumos = [],
    porcentajeVenta = 0,
  } = req.body || {};

  const comps = (Array.isArray(componentes) ? componentes : [])
    .map(c => ({ articleId: Number(c.articleId), cantidad: Number(c.cantidad) || 1, unidad: c.unidad || 'u' }))
    .filter(c => Number.isFinite(c.articleId) && c.articleId !== 0);

  if (comps.length < 1) {
    return res.status(400).json({ ok: false, error: 'Se requiere al menos un artículo componente' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const storageBizId = await resolveStorageBizId(bizId);

    // 1. Resolver info de cada componente (nombre + rubro + costo)
    const compInfos = [];
    for (const c of comps) {
      const info = await resolveArticuloInfo(client, storageBizId, c.articleId);
      if (!info) {
        await client.query('ROLLBACK');
        return res.status(404).json({ ok: false, error: `Artículo ${c.articleId} no encontrado` });
      }
      compInfos.push({ ...c, ...info });
    }

    // 2. Nombre de la promo: manual o concatenación de componentes
    const nombrePromo = (nombreManual && nombreManual.trim())
      || compInfos.map(ci => ci.nombre).join(' + ');

    // 3. Rubro heredado del primer componente (v1)
    const rubroCategoria = compInfos[0].categoria || 'Promociones';
    const rubroSubrubro = compInfos[0].subrubro || 'Promociones';

    // 4. Costo total de la promo = suma de (costo componente × cantidad) + insumos
    let costoTotal = 0;
    for (const ci of compInfos) {
      costoTotal += (Number(ci.costo) || 0) * ci.cantidad;
    }
    // Insumos propios
    const insumosNorm = (Array.isArray(insumos) ? insumos : [])
      .map(i => ({ insumoId: Number(i.insumoId), cantidad: Number(i.cantidad) || 0, unidad: i.unidad || 'u' }))
      .filter(i => Number.isFinite(i.insumoId) && i.insumoId !== 0);
    const insumoInfos = [];
    for (const ins of insumosNorm) {
      const { rows } = await client.query(
        `SELECT id, nombre, unidad_med, precio_ref, codigo_maxi
           FROM insumos WHERE id = $1 AND business_id = $2 LIMIT 1`,
        [ins.insumoId, storageBizId]
      );
      if (rows.length) {
        const costoIns = (Number(rows[0].precio_ref) || 0) * ins.cantidad;
        costoTotal += costoIns;
        insumoInfos.push({ ...ins, ...rows[0], costoUnitario: Number(rows[0].precio_ref) || 0 });
      }
    }

    // 5. Generar ID negativo global + SKU
    const { rows: minRows } = await client.query(
      `SELECT COALESCE(MIN(id), 0) - 1 AS next_id FROM app_articles WHERE id < 0`
    );
    const newId = Math.min(minRows[0].next_id, -1);
    const sku = `L${String(Math.abs(newId)).padStart(3, '0')}`;

    // 6. Insertar artículo-promo en app_articles
    await client.query(
      `INSERT INTO app_articles
         (id, business_id, name, rubro, subrubro, node_type, price, codigo, props, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'item', $6, $7, $8, NOW())`,
      [
        newId, storageBizId, nombrePromo, rubroCategoria, rubroSubrubro,
        0, sku,
        JSON.stringify({ origen: 'promo', sku, es_promo: true, sin_equivalencia: true }),
      ]
    );

    // 7. Insertar en maxi_articles para que aparezca en el árbol
    const manualBatchId = `promo-${new Date().toISOString().slice(0, 10)}`;
    await client.query(
      `INSERT INTO maxi_articles
         (business_id, articulo_id, nombre, categoria, subrubro, precio, costo, raw, origen, upload_batch_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, '{}'::jsonb, 'promo', $8, NOW())
       ON CONFLICT (business_id, articulo_id) DO UPDATE SET
         nombre = EXCLUDED.nombre, categoria = EXCLUDED.categoria,
         subrubro = EXCLUDED.subrubro, precio = EXCLUDED.precio,
         costo = EXCLUDED.costo, updated_at = NOW()`,
      [storageBizId, newId, nombrePromo, rubroCategoria, rubroSubrubro, 0,
       Math.round(costoTotal * 100) / 100, manualBatchId]
    );

    // 8. Crear la receta de la promo (es_promo = TRUE)
    const { rows: recRows } = await client.query(
      `INSERT INTO recetas
         (article_id, business_id, nombre, porciones, porcentaje_venta,
          costo_total, es_promo, active, origen, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, 1, $4, $5, TRUE, TRUE, 'promo', $6, NOW(), NOW())
       RETURNING id`,
      [newId, storageBizId, nombrePromo, Number(porcentajeVenta) || 0,
       Math.round(costoTotal * 10000) / 10000, uid]
    );
    const recetaId = recRows[0].id;

    // 9. Insertar items: primero los artículos componentes, luego los insumos
    let orden = 0;
    for (const ci of compInfos) {
      await client.query(
        `INSERT INTO receta_items
           (receta_id, article_ref_id, cantidad, unidad, costo_unitario,
            nombre_insumo_maxi, tipo_costo, merma, pedido, orden, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'total', TRUE, TRUE, $7, NOW(), NOW())`,
        [recetaId, ci.articleId, ci.cantidad, ci.unidad,
         Math.round((Number(ci.costo) || 0) * 10000) / 10000, ci.nombre, orden++]
      );
    }
    for (const ii of insumoInfos) {
      await client.query(
        `INSERT INTO receta_items
           (receta_id, insumo_id, cantidad, unidad, costo_unitario,
            codigo_maxi_insumo, nombre_insumo_maxi, tipo_costo, merma, pedido, orden, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'total', TRUE, TRUE, $8, NOW(), NOW())`,
        [recetaId, ii.insumoId, ii.cantidad, ii.unidad,
         Math.round(ii.costoUnitario * 10000) / 10000,
         ii.codigo_maxi || null, ii.nombre || null, orden++]
      );
    }

    // 10. Meter el artículo-promo en la agrupación "Promociones" (crearla si no existe)
    let promoAgrupId;
    const { rows: agExist } = await client.query(
      `SELECT id, articulos, app_articles_ids FROM agrupaciones
        WHERE business_id = $1 AND nombre ILIKE 'Promociones' LIMIT 1`,
      [storageBizId]
    );
    if (agExist.length) {
      promoAgrupId = agExist[0].id;
      const articulos = Array.isArray(agExist[0].articulos) ? agExist[0].articulos : [];
      const appIds = Array.isArray(agExist[0].app_articles_ids) ? agExist[0].app_articles_ids : [];
      articulos.push({ id: newId, nombre: nombrePromo, precio: 0 });
      appIds.push(newId);
      await client.query(
        `UPDATE agrupaciones SET articulos = $1, app_articles_ids = $2, updated_at = NOW() WHERE id = $3`,
        [JSON.stringify(articulos), JSON.stringify(appIds), promoAgrupId]
      );
    } else {
      const { rows: agNew } = await client.query(
        `INSERT INTO agrupaciones (business_id, nombre, articulos, app_articles_ids, created_at, updated_at)
         VALUES ($1, 'Promociones', $2::jsonb, $3::jsonb, NOW(), NOW())
         RETURNING id`,
        [storageBizId,
         JSON.stringify([{ id: newId, nombre: nombrePromo, precio: 0 }]),
         JSON.stringify([newId])]
      );
      promoAgrupId = agNew[0].id;
    }

    await client.query('COMMIT');
    invalidateCacheForBiz(bizId);
    if (storageBizId !== bizId) invalidateCacheForBiz(storageBizId);

    console.log(`[crearPromocion] Promo id=${newId} "${nombrePromo}" biz=${bizId} costo=${costoTotal.toFixed(2)}`);

    return res.status(201).json({
      ok: true,
      promo: {
        id: newId, sku, nombre: nombrePromo,
        costoTotal: Math.round(costoTotal * 100) / 100,
        rubro: rubroCategoria, subrubro: rubroSubrubro,
        recetaId, agrupacionId: promoAgrupId,
        componentes: compInfos.map(ci => ({ id: ci.articleId, nombre: ci.nombre })),
      },
    });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { }
    console.error('[crearPromocion]', e);
    next(e);
  } finally {
    client.release();
  }
};