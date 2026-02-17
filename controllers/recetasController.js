// controllers/recetasController.js
const pool = require('../config/db');

/* ══════════════════════════════════════════════════════════════
   GET /api/businesses/:businessId/articles/:articleId/receta
   Devuelve la receta de un artículo en un negocio específico
══════════════════════════════════════════════════════════════ */
exports.getReceta = async (req, res, next) => {
  try {
    const bizId     = Number(req.params.businessId);
    const articleId = Number(req.params.articleId);

    if (!bizId || !articleId) {
      return res.status(400).json({ ok: false, error: 'invalid_params' });
    }

    // Receta principal
    const { rows: recetaRows } = await pool.query(
      `SELECT
         r.id,
         r.article_id,
         r.business_id,
         r.nombre,
         r.descripcion,
         r.porciones,
         r.porcentaje_venta,
         r.costo_total,
         r.active,
         r.created_at,
         r.updated_at
       FROM recetas r
      WHERE r.article_id = $1
        AND r.business_id = $2
        AND r.active = TRUE
      LIMIT 1`,
      [articleId, bizId]
    );

    if (!recetaRows.length) {
      return res.json({ ok: true, receta: null });
    }

    const receta = recetaRows[0];

    // Items de la receta con info del insumo
    const { rows: items } = await pool.query(
      `SELECT
         ri.id,
         ri.receta_id,
         ri.supply_id,
         ms.nombre       AS supply_nombre,
         ms.medida       AS supply_medida,
         ms.precio       AS supply_precio_base,
         ri.cantidad,
         ri.unidad,
         ri.costo_unitario,
         ROUND(ri.cantidad * ri.costo_unitario, 4) AS costo_total_item,
         ri.notas,
         ri.orden
       FROM receta_items ri
       JOIN maxi_supplies ms ON ms.id = ri.supply_id
      WHERE ri.receta_id = $1
      ORDER BY ri.orden ASC, ri.id ASC`,
      [receta.id]
    );

    return res.json({
      ok: true,
      receta: {
        ...receta,
        items,
      },
    });
  } catch (e) {
    console.error('[getReceta]', e);
    next(e);
  }
};

/* ══════════════════════════════════════════════════════════════
   POST /api/businesses/:businessId/articles/:articleId/receta
   Crear o actualizar receta (upsert completo con sus items)

   Body: {
     nombre?: string,
     descripcion?: string,
     porciones?: number,
     porcentajeVenta?: number,    // % de margen de venta
     items: [
       {
         supplyId: number,        // ID en maxi_supplies
         cantidad: number,
         unidad: string,          // 'gr', 'kg', 'ml', 'lt', 'u'
         costoUnitario: number,   // precio que paga ESTE negocio
         notas?: string,
         orden?: number,
       }
     ]
   }
══════════════════════════════════════════════════════════════ */
exports.saveReceta = async (req, res, next) => {
  const client = await pool.connect();
  try {
    const bizId     = Number(req.params.businessId);
    const articleId = Number(req.params.articleId);
    const uid       = req.user?.id;

    if (!bizId || !articleId) {
      return res.status(400).json({ ok: false, error: 'invalid_params' });
    }

    const {
      nombre,
      descripcion,
      porciones        = 1,
      porcentajeVenta  = 0,
      items            = [],
    } = req.body || {};

    // Validar items mínimos
    if (!Array.isArray(items)) {
      return res.status(400).json({ ok: false, error: 'items_must_be_array' });
    }

    // Calcular costo total desde los items
    const costoTotal = items.reduce((acc, item) => {
      const cantidad      = Number(item.cantidad      || 0);
      const costoUnitario = Number(item.costoUnitario || 0);
      return acc + (cantidad * costoUnitario);
    }, 0);

    await client.query('BEGIN');

    // UPSERT de la receta
    const { rows: recetaRows } = await client.query(
      `INSERT INTO recetas
         (article_id, business_id, nombre, descripcion, porciones,
          porcentaje_venta, costo_total, active, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, $8, NOW(), NOW())
       ON CONFLICT (article_id, business_id)
       DO UPDATE SET
         nombre           = EXCLUDED.nombre,
         descripcion      = EXCLUDED.descripcion,
         porciones        = EXCLUDED.porciones,
         porcentaje_venta = EXCLUDED.porcentaje_venta,
         costo_total      = EXCLUDED.costo_total,
         active           = TRUE,
         updated_at       = NOW()
       RETURNING *`,
      [
        articleId,
        bizId,
        nombre?.trim()      || null,
        descripcion?.trim() || null,
        Number(porciones)   || 1,
        Number(porcentajeVenta) || 0,
        Math.round(costoTotal * 10000) / 10000,
        uid,
      ]
    );

    const receta = recetaRows[0];

    // Reemplazar items: borrar todos y reinsertar
    await client.query(
      `DELETE FROM receta_items WHERE receta_id = $1`,
      [receta.id]
    );

    const savedItems = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const supplyId      = Number(item.supplyId);
      const cantidad      = Number(item.cantidad      || 0);
      const costoUnitario = Number(item.costoUnitario || 0);
      const unidad        = (item.unidad || '').trim() || null;
      const notas         = (item.notas  || '').trim() || null;
      const orden         = Number.isFinite(Number(item.orden)) ? Number(item.orden) : i;

      if (!Number.isFinite(supplyId) || supplyId <= 0) continue;
      if (cantidad <= 0) continue;

      // Validar que el insumo existe
      const { rows: supplyCheck } = await client.query(
        `SELECT id, nombre, medida FROM maxi_supplies WHERE id = $1 LIMIT 1`,
        [supplyId]
      );

      if (!supplyCheck.length) {
        console.warn(`[saveReceta] supply_id=${supplyId} no existe, ignorando item`);
        continue;
      }

      const { rows: itemRows } = await client.query(
        `INSERT INTO receta_items
           (receta_id, supply_id, cantidad, unidad, costo_unitario, notas, orden, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
         RETURNING *`,
        [receta.id, supplyId, cantidad, unidad, costoUnitario, notas, orden]
      );

      savedItems.push({
        ...itemRows[0],
        supply_nombre: supplyCheck[0].nombre,
        supply_medida: supplyCheck[0].medida,
        costo_total_item: Math.round(cantidad * costoUnitario * 10000) / 10000,
      });
    }

    await client.query('COMMIT');

    console.log(`✅ [saveReceta] Receta ID=${receta.id} | Art=${articleId} | Biz=${bizId} | ${savedItems.length} items | Costo=$${costoTotal.toFixed(4)}`);

    return res.json({
      ok: true,
      receta: {
        ...receta,
        items: savedItems,
      },
    });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('[saveReceta]', e);
    next(e);
  } finally {
    client.release();
  }
};

/* ══════════════════════════════════════════════════════════════
   DELETE /api/businesses/:businessId/articles/:articleId/receta
   Soft delete de la receta (active = FALSE)
══════════════════════════════════════════════════════════════ */
exports.deleteReceta = async (req, res, next) => {
  try {
    const bizId     = Number(req.params.businessId);
    const articleId = Number(req.params.articleId);

    if (!bizId || !articleId) {
      return res.status(400).json({ ok: false, error: 'invalid_params' });
    }

    const { rows } = await pool.query(
      `UPDATE recetas
          SET active = FALSE, updated_at = NOW()
        WHERE article_id = $1
          AND business_id = $2
          AND active = TRUE
        RETURNING id`,
      [articleId, bizId]
    );

    if (!rows.length) {
      return res.status(404).json({ ok: false, error: 'receta_not_found' });
    }

    console.log(`🗑️ [deleteReceta] Receta ID=${rows[0].id} desactivada`);

    return res.json({ ok: true, deleted: true });
  } catch (e) {
    console.error('[deleteReceta]', e);
    next(e);
  }
};