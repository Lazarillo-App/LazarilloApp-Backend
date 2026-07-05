// controllers/recetasController.js
const pool = require('../config/db');
const { propagateRecipe } = require('../services/linkPropagation');

exports.getReceta = async (req, res, next) => {
  try {
    const bizId = Number(req.params.businessId);
    const articleId = Number(req.params.articleId);

    if (!bizId || !articleId) {
      return res.status(400).json({ ok: false, error: 'invalid_params' });
    }

    const { rows: recetaRows } = await pool.query(
      `SELECT
         r.id, r.article_id, r.business_id, r.nombre, r.descripcion,
         r.porciones, r.porcentaje_venta, r.costo_total, r.active,
         r.notas, r.foto, r.notas_updated_at,
         r.rendimiento_unidad, r.rendimiento_peso, r.unidad_peso,
         r.created_at, r.updated_at
       FROM recetas r
      WHERE r.article_id = $1 AND r.business_id = $2 AND r.active = TRUE
      LIMIT 1`,
      [articleId, bizId]
    );

    if (!recetaRows.length) {
      return res.json({ ok: true, receta: null });
    }

    const receta = recetaRows[0];

    const { rows: items } = await pool.query(
      `SELECT
         ri.id, ri.receta_id,
         COALESCE(ri.insumo_id, ri.supply_id)                    AS supply_id,
         COALESCE(i.nombre, ri.nombre_insumo_maxi, ms.nombre)    AS supply_nombre,
         COALESCE(i.unidad_med, ri.unidad, ms.medida)            AS supply_medida,
         COALESCE(i.precio_ref, 0)                               AS precio_ref_db,
         ri.cantidad, ri.unidad, ri.costo_unitario,
         ROUND(ri.cantidad * ri.costo_unitario, 4)               AS costo_total_item,
         ri.notas, ri.observaciones, ri.fotos_urls,
         ri.merma, ri.pedido, ri.tipo_costo, ri.orden,
         ri.codigo_maxi_insumo, ri.nombre_insumo_maxi,
         ri.article_ref_id,
         ri.updated_at
       FROM receta_items ri
       LEFT JOIN insumos i      ON i.id  = ri.insumo_id
       LEFT JOIN maxi_supplies ms ON ms.id = ri.supply_id
      WHERE ri.receta_id = $1
      ORDER BY ri.orden ASC, ri.id ASC`,
      [receta.id]
    );

    return res.json({ ok: true, receta: { ...receta, items } });
  } catch (e) {
    console.error('[getReceta]', e);
    next(e);
  }
};

exports.saveReceta = async (req, res, next) => {
  const client = await pool.connect();
  try {
    const bizId = Number(req.params.businessId);
    const articleId = Number(req.params.articleId);
    const uid = req.user?.id;

    if (!bizId || !articleId) {
      return res.status(400).json({ ok: false, error: 'invalid_params' });
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
      notasUpdatedAt,
    } = req.body || {};

    // Normalizar y validar campos del rendimiento del lote
    const VALID_RU = ['porcion', 'u', 'lt', 'ml', 'kg', 'gr'];
    const VALID_UP = ['gr', 'kg'];
    const ruFinal = VALID_RU.includes(rendimientoUnidad) ? rendimientoUnidad : 'porcion';
    // Peso solo aplica cuando la unidad es lt/ml/u (las demás no lo necesitan)
    const aplicaPeso = ['lt', 'ml', 'u'].includes(ruFinal);
    const rpFinal = aplicaPeso && rendimientoPeso != null && Number(rendimientoPeso) > 0
      ? Number(rendimientoPeso)
      : null;
    const upFinal = aplicaPeso && VALID_UP.includes(unidadPeso) ? unidadPeso : null;

    if (!Array.isArray(items)) {
      return res.status(400).json({ ok: false, error: 'items_must_be_array' });
    }

    const costoTotal = items.reduce((acc, item) => {
      const cant = Number(item.cantidad || 0);
      if (cant === 0) return acc; // solo ignorar cero exacto
      return acc + (cant * Number(item.costoUnitario || 0));
    }, 0);
    console.log('[saveReceta] params:', { bizId, articleId, uid });
    await client.query('BEGIN');

    // ── Upsert receta en dos pasos (más robusto) ──
    const { rows: existing } = await client.query(
      `SELECT id FROM recetas 
   WHERE article_id = $1 AND business_id = $2`,
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
       notas_updated_at   = $8,
       rendimiento_unidad = $9,
       rendimiento_peso   = $10,
       unidad_peso        = $11,
       active             = TRUE,
       origen             = 'manual',
       updated_at         = NOW()
     WHERE id = $12
     RETURNING *`,
        [
          nombre?.trim() || null,
          descripcion?.trim() || null,
          Number(porciones) || 1,
          Number(porcentajeVenta) || 0,
          Math.round(costoTotal * 10000) / 10000,
          notas?.trim() || null,
          foto || null,
          notasUpdatedAt || null,
          ruFinal, rpFinal, upFinal,
          existing[0].id,
        ]
      );
      recetaRows = rows;
    } else {
      const { rows } = await client.query(
        `INSERT INTO recetas
       (article_id, business_id, nombre, descripcion, porciones,
        porcentaje_venta, costo_total, notas, foto, notas_updated_at,
        rendimiento_unidad, rendimiento_peso, unidad_peso,
        active, origen, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, TRUE, 'manual', NOW(), NOW())
     RETURNING *`,
        [
          articleId, bizId,
          nombre?.trim() || null,
          descripcion?.trim() || null,
          Number(porciones) || 1,
          Number(porcentajeVenta) || 0,
          Math.round(costoTotal * 10000) / 10000,
          notas?.trim() || null,
          foto || null,
          notasUpdatedAt || null,
          ruFinal, rpFinal, upFinal,
        ]
      );
      recetaRows = rows;
    }

    const receta = recetaRows[0];
    // ── Reemplazar items ──
    await client.query(`DELETE FROM receta_items WHERE receta_id = $1`, [receta.id]);

    const savedItems = [];

   for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const cantidad = Number(item.cantidad || 0);
      const costoUnitario = Number(item.costoUnitario || 0);
      const unidad = (item.unidad || '').trim() || null;
      const notas = (item.notas || '').trim() || null;
      const orden = Number.isFinite(Number(item.orden)) ? Number(item.orden) : i;
      const merma = item.merma !== false;
      const pedido = item.pedido !== false;
      const tipoCosto = (item.tipoCosto || 'total').trim();
      const observaciones = (item.observaciones || '').trim() || null;
      const fotosUrls = Array.isArray(item.fotosUrls)
        ? item.fotosUrls.filter(u => typeof u === 'string' && u.startsWith('http'))
        : [];

      if (cantidad === 0) continue;

      // ── Item-artículo (promo): referencia a otro artículo ──
      const articleRefId = Number(item.articleRefId);
      if (Number.isFinite(articleRefId) && articleRefId !== 0) {
        // Nombre del artículo referenciado (positivo=maxi, negativo=manual)
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
              nombre_insumo_maxi, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW(), NOW())
           RETURNING *`,
          [
            receta.id, articleRefId, cantidad, unidad, costoUnitario, notas,
            observaciones, fotosUrls, merma, pedido, tipoCosto, orden, refNombre,
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

      // ── Item-insumo (receta normal) ──
      const supplyId = Number(item.supplyId);
      if (!Number.isFinite(supplyId) || supplyId <= 0) continue;
      const { rows: insumoCheck } = await client.query(
        `SELECT id, nombre, unidad_med FROM insumos WHERE id = $1 LIMIT 1`,
        [supplyId]
      );
      if (!insumoCheck.length) {
        console.warn(`[saveReceta] insumo_id=${supplyId} no existe en tabla insumos, ignorando item`);
        continue;
      }
      const { rows: itemRows } = await client.query(
        `INSERT INTO receta_items
           (receta_id, insumo_id, cantidad, unidad, costo_unitario, notas,
            observaciones, fotos_urls, merma, pedido, tipo_costo, orden,
            created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), NOW())
         RETURNING *`,
        [
          receta.id, supplyId, cantidad, unidad, costoUnitario, notas,
          observaciones, fotosUrls, merma, pedido, tipoCosto, orden,
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

    // ── Marcar es_promo si la receta contiene items-artículo ──
    const esPromo = items.some(it => {
      const ref = Number(it.articleRefId);
      return Number.isFinite(ref) && ref !== 0;
    });
    await client.query(
      `UPDATE recetas SET es_promo = $1 WHERE id = $2`,
      [esPromo, receta.id]
    );

    // ── Actualizar costo en insumos elaborados ──
    // El precio del insumo elaborado es SIEMPRE el costo total de su receta.
    // El rendimiento/porciones es solo informativo (para conversiones de unidad).
    const porcentaje = Number(porcentajeVenta) || 0;

    await client.query(
      `UPDATE insumos
       SET costo_receta = $1, precio_ref = $1, tiene_receta = TRUE, updated_at = NOW()
       WHERE id = $2 AND business_id = $3
         AND (es_elaborado = TRUE OR es_elaborado_manual = TRUE)`,
      [Math.round(costoTotal * 1000) / 1000, articleId, bizId]
    );

    // ── Sincronizar porcentajeVenta → price_config como objetivo individual ──
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

    await client.query('COMMIT');

    console.log(`✅ [saveReceta] Receta ID=${receta.id} | Art=${articleId} | Biz=${bizId} | ${savedItems.length} items | Costo=$${costoTotal.toFixed(4)}`);

    // ── Propagación a artículos vinculados (fire-and-forget) ──
    propagateRecipe({ bizId, articleId, receta, savedItems }).catch(e =>
      console.warn('[saveReceta] propagateRecipe falló (no crítico):', e.message)
    );

    return res.json({
      ok: true,
      receta: { ...receta, items: savedItems },
    });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { }
    console.error('[saveReceta]', e);
    next(e);
  } finally {
    client.release();
  }
};

exports.deleteReceta = async (req, res, next) => {
  try {
    const bizId = Number(req.params.businessId);
    const articleId = Number(req.params.articleId);

    if (!bizId || !articleId) {
      return res.status(400).json({ ok: false, error: 'invalid_params' });
    }

    const { rows } = await pool.query(
      `UPDATE recetas
          SET active = FALSE, updated_at = NOW()
        WHERE article_id = $1 AND business_id = $2 AND active = TRUE
        RETURNING id`,
      [articleId, bizId]
    );

    if (!rows.length) {
      return res.status(404).json({ ok: false, error: 'receta_not_found' });
    }

    await pool.query(
      `UPDATE insumos
       SET costo_receta = 0, tiene_receta = FALSE, updated_at = NOW()
       WHERE id = $1 AND business_id = $2
         AND (es_elaborado = TRUE OR es_elaborado_manual = TRUE)`,
      [articleId, bizId]
    );

    await pool.query(
      `DELETE FROM article_price_config
       WHERE business_id = $1 AND scope = 'articulo' AND scope_id = $2`,
      [bizId, String(articleId)]
    );

    console.log(`🗑️ [deleteReceta] Receta ID=${rows[0].id} desactivada`);

    return res.json({ ok: true, deleted: true });
  } catch (e) {
    console.error('[deleteReceta]', e);
    next(e);
  }
};

exports.propagateReceta = async (req, res, next) => {
  try {
    const bizId = Number(req.params.businessId);
    const articleId = Number(req.params.articleId);

    if (!bizId || !articleId) {
      return res.status(400).json({ ok: false, error: 'invalid_params' });
    }

    // Obtener receta existente con sus items
    const { rows: recetaRows } = await pool.query(
      `SELECT r.* FROM recetas r
       WHERE r.article_id = $1 AND r.business_id = $2 AND r.active = TRUE
       LIMIT 1`,
      [articleId, bizId]
    );

    if (!recetaRows.length) {
      return res.json({ ok: true, propagated: 0, reason: 'no_receta' });
    }

    const receta = recetaRows[0];

    const { rows: itemRows } = await pool.query(
      `SELECT ri.*, i.nombre AS supply_nombre, i.unidad_med AS supply_medida
       FROM receta_items ri
       LEFT JOIN insumos i ON i.id = ri.insumo_id
       WHERE ri.receta_id = $1`,
      [receta.id]
    );

    const result = await propagateRecipe({
      bizId,
      articleId,
      receta,
      savedItems: itemRows
    });

    return res.json({ ok: true, propagated: result?.count || 0 });
  } catch (e) {
    console.error('[propagateReceta]', e);
    next(e);
  }
};