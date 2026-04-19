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
         ri.notas, ri.observaciones, ri.merma, ri.pedido,
         ri.tipo_costo, ri.orden, ri.codigo_maxi_insumo, ri.nombre_insumo_maxi
       FROM receta_items ri
       LEFT JOIN insumos i  ON i.id  = ri.insumo_id
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
      items = [],
    } = req.body || {};

    if (!Array.isArray(items)) {
      return res.status(400).json({ ok: false, error: 'items_must_be_array' });
    }

    const costoTotal = items.reduce((acc, item) => {
      return acc + (Number(item.cantidad || 0) * Number(item.costoUnitario || 0));
    }, 0);

    await client.query('BEGIN');

    // ── Upsert receta ──
    const { rows: recetaRows } = await client.query(
      `INSERT INTO recetas
         (article_id, business_id, nombre, descripcion, porciones,
          porcentaje_venta, costo_total, active, origen, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, 'manual', $8, NOW(), NOW())
       ON CONFLICT (article_id, business_id)
       DO UPDATE SET
         nombre           = EXCLUDED.nombre,
         descripcion      = EXCLUDED.descripcion,
         porciones        = EXCLUDED.porciones,
         porcentaje_venta = EXCLUDED.porcentaje_venta,
         costo_total      = EXCLUDED.costo_total,
         active           = TRUE,
         origen           = 'manual',
         updated_at       = NOW()
       RETURNING *`,
      [
        articleId, bizId,
        nombre?.trim() || null,
        descripcion?.trim() || null,
        Number(porciones) || 1,
        Number(porcentajeVenta) || 0,
        Math.round(costoTotal * 10000) / 10000,
        uid,
      ]
    );

    const receta = recetaRows[0];

    // ── Reemplazar items ──
    await client.query(`DELETE FROM receta_items WHERE receta_id = $1`, [receta.id]);

    const savedItems = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const supplyId = Number(item.supplyId);
      const cantidad = Number(item.cantidad || 0);
      const costoUnitario = Number(item.costoUnitario || 0);
      const unidad = (item.unidad || '').trim() || null;
      const notas = (item.notas || '').trim() || null;
      const orden = Number.isFinite(Number(item.orden)) ? Number(item.orden) : i;

      if (!Number.isFinite(supplyId) || supplyId <= 0) continue;
      if (cantidad <= 0) continue;

      const { rows: insumoCheck } = await client.query(
        `SELECT id, nombre, unidad_med FROM insumos WHERE id = $1 LIMIT 1`,
        [supplyId]
      );

      if (!insumoCheck.length) {
        console.warn(`[saveReceta] insumo_id=${supplyId} no existe en tabla insumos, ignorando item`);
        continue;
      }

      const merma = item.merma !== false;
      const pedido = item.pedido !== false;
      const tipoCosto = (item.tipoCosto || 'total').trim();
      const observaciones = (item.observaciones || '').trim() || null;

      const { rows: itemRows } = await client.query(
        `INSERT INTO receta_items
           (receta_id, insumo_id, cantidad, unidad, costo_unitario, notas,
            observaciones, merma, pedido, tipo_costo, orden, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), NOW())
         RETURNING *`,
        [receta.id, supplyId, cantidad, unidad, costoUnitario, notas,
          observaciones, merma, pedido, tipoCosto, orden]
      );

      savedItems.push({
        ...itemRows[0],
        supply_id: supplyId,
        supply_nombre: insumoCheck[0].nombre,
        supply_medida: insumoCheck[0].unidad_med,
        costo_total_item: Math.round(cantidad * costoUnitario * 10000) / 10000,
      });
    }

    // ── Actualizar costo en insumos elaborados ──
    const costoXPorcion = Number(porciones) > 0 ? costoTotal / Number(porciones) : costoTotal;
    const porcentaje = Number(porcentajeVenta) || 0;

    await client.query(
      `UPDATE insumos
       SET costo_receta = $1, precio_ref = $1, tiene_receta = TRUE, updated_at = NOW()
       WHERE id = $2 AND business_id = $3
         AND (es_elaborado = TRUE OR es_elaborado_manual = TRUE)`,
      [Math.round(costoXPorcion * 1000) / 1000, articleId, bizId]
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

    // ── Propagación a artículos vinculados (fire-and-forget, no bloquea response) ──
    propagateRecipe({ bizId, articleId, receta, savedItems }).catch(e =>
      console.warn('[saveReceta] propagateRecipe falló (no crítico):', e.message)
    );

    return res.json({
      ok: true,
      receta: { ...receta, items: savedItems },
    });
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