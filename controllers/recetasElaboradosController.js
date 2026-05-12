// controllers/recetasElaboradosController.js
const pool = require('../config/db');

/* ══════════════════════════════════════════════════════════════
   GET /api/businesses/:businessId/insumos/:insumoId/receta
══════════════════════════════════════════════════════════════ */
exports.getRecetaElaborado = async (req, res, next) => {
  try {
    const bizId = Number(req.params.businessId);
    const insumoId = Number(req.params.insumoId);

    if (!bizId || !insumoId) {
      return res.status(400).json({ ok: false, error: 'invalid_params' });
    }

    const { rows: recetaRows } = await pool.query(
      `SELECT r.*
         FROM recetas r
        WHERE r.insumo_id  = $1
          AND r.business_id = $2
          AND r.active      = TRUE
        LIMIT 1`,
      [insumoId, bizId]
    );

    if (!recetaRows.length) {
      return res.json({ ok: true, receta: null });
    }

    const receta = recetaRows[0];

    const { rows: items } = await pool.query(
      `SELECT
         ri.id,
         ri.receta_id,
         COALESCE(ri.insumo_id, ri.supply_id)                    AS supply_id,
         COALESCE(i.nombre, ri.nombre_insumo_maxi)               AS supply_nombre,
         COALESCE(i.unidad_med, ri.unidad)                       AS supply_medida,
         COALESCE(i.precio_ref, 0)                               AS precio_ref_db,
         ri.cantidad,
         ri.unidad,
         ri.costo_unitario,
         ROUND(ri.cantidad * ri.costo_unitario, 4)               AS costo_total_item,
         ri.notas,
         ri.observaciones,
         ri.fotos_urls,
         ri.merma,
         ri.pedido,
         ri.tipo_costo,
         ri.orden,
         ri.codigo_maxi_insumo,
         ri.nombre_insumo_maxi
       FROM receta_items ri
       LEFT JOIN insumos i ON i.id = ri.insumo_id
      WHERE ri.receta_id = $1
      ORDER BY ri.orden ASC, ri.id ASC`,
      [receta.id]
    );

    // Incluir config del negocio para que el front sepa el % objetivo global de insumos
    let insumosConfigObjetivo = 30;
    try {
      const { rows: bizRows } = await pool.query(
        `SELECT props FROM app_businesses WHERE id = $1 LIMIT 1`, [bizId]
      );
      if (bizRows.length) {
        insumosConfigObjetivo = Number(bizRows[0].props?.insumos_costo_ideal ?? 30);
      }
    } catch { /* no crítico */ }

    return res.json({
      ok: true,
      receta: { ...receta, items },
      insumos_costo_ideal: insumosConfigObjetivo,
    });
  } catch (e) {
    console.error('[getRecetaElaborado]', e);
    next(e);
  }
};

/* ══════════════════════════════════════════════════════════════
   POST /api/businesses/:businessId/insumos/:insumoId/receta
══════════════════════════════════════════════════════════════ */
exports.saveRecetaElaborado = async (req, res, next) => {
  const client = await pool.connect();
  try {
    const bizId = Number(req.params.businessId);
    const insumoId = Number(req.params.insumoId);
    const uid = req.user?.id;

    if (!bizId || !insumoId) {
      return res.status(400).json({ ok: false, error: 'invalid_params' });
    }

    // Verificar que el insumo existe y es elaborado
    const { rows: insumoRows } = await client.query(
      `SELECT id, nombre, unidad_med, es_elaborado, es_elaborado_manual
         FROM insumos
        WHERE id = $1 AND business_id = $2`,
      [insumoId, bizId]
    );

    if (!insumoRows.length) {
      return res.status(404).json({ ok: false, error: 'insumo_not_found' });
    }

    const insumo = insumoRows[0];
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
      items = [],
    } = req.body || {};

    if (!Array.isArray(items)) {
      return res.status(400).json({ ok: false, error: 'items_must_be_array' });
    }

    // Calcular costo total
    const costoTotal = items.reduce((acc, item) => {
      const cant = Number(item.cantidad || 0);
      if (cant === 0) return acc; // solo ignorar cero exacto
      return acc + (cant * Number(item.costoUnitario || 0));
    }, 0);

    const porcionesNum  = Math.max(1, Number(porciones) || 1);
    const costoXPorcion = costoTotal / porcionesNum;

    // Si no viene porcentajeVenta, usar el global de insumos del negocio
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

    // UPSERT receta
    const { rows: recetaRows } = await client.query(
      `INSERT INTO recetas
         (insumo_id, business_id, nombre, descripcion, porciones,
          porcentaje_venta, costo_total, active, origen, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, 'manual', $8, NOW(), NOW())
       ON CONFLICT ON CONSTRAINT recetas_insumo_biz_key
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
        insumoId, bizId,
        nombre?.trim() || insumo.nombre,
        descripcion?.trim() || null,
        porcionesNum,
        porcentajeNum,
        Math.round(costoTotal * 10000) / 10000,
        uid,
      ]
    );

    const receta = recetaRows[0];

    // Reemplazar items
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
      if (cantidad === 0) continue;

      const { rows: insumoCheck } = await client.query(
        `SELECT id, nombre, unidad_med FROM insumos WHERE id = $1 LIMIT 1`,
        [supplyId]
      );
      if (!insumoCheck.length) continue;

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

    // ── Actualizar precio_ref y costo_receta en el insumo elaborado ──
    await client.query(
      `UPDATE insumos
          SET precio_ref   = $1,
              costo_receta = $1,
              tiene_receta = TRUE,
              updated_at   = NOW()
        WHERE id = $2 AND business_id = $3`,
      [Math.round(costoXPorcion * 1000) / 1000, insumoId, bizId]
    );

    await client.query('COMMIT');

    console.log(`✅ [saveRecetaElaborado] Insumo=${insumoId} | Biz=${bizId} | Costo/u=$${costoXPorcion.toFixed(4)} | PrecioSug=$${precioSugerido.toFixed(4)}`);

    return res.json({
      ok: true,
      receta: { ...receta, items: savedItems },
      costo_por_porcion: costoXPorcion,
      precio_sugerido: precioSugerido,
      porciones: porcionesNum,
    });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { }
    console.error('[saveRecetaElaborado]', e);
    next(e);
  } finally {
    client.release();
  }
};

/* ══════════════════════════════════════════════════════════════
   DELETE /api/businesses/:businessId/insumos/:insumoId/receta
══════════════════════════════════════════════════════════════ */
exports.deleteRecetaElaborado = async (req, res, next) => {
  try {
    const bizId = Number(req.params.businessId);
    const insumoId = Number(req.params.insumoId);

    if (!bizId || !insumoId) {
      return res.status(400).json({ ok: false, error: 'invalid_params' });
    }

    const { rows } = await pool.query(
      `UPDATE recetas
          SET active = FALSE, updated_at = NOW()
        WHERE insumo_id  = $1
          AND business_id = $2
          AND active      = TRUE
        RETURNING id`,
      [insumoId, bizId]
    );

    if (!rows.length) {
      return res.status(404).json({ ok: false, error: 'receta_not_found' });
    }

    // Limpiar precio en el insumo
    await pool.query(
      `UPDATE insumos
          SET costo_receta = 0,
              tiene_receta = FALSE,
              updated_at   = NOW()
        WHERE id = $1 AND business_id = $2`,
      [insumoId, bizId]
    );

    console.log(`🗑️ [deleteRecetaElaborado] Receta ID=${rows[0].id} | Insumo=${insumoId} desactivada`);

    return res.json({ ok: true, deleted: true });
  } catch (e) {
    console.error('[deleteRecetaElaborado]', e);
    next(e);
  }
};

/* ══════════════════════════════════════════════════════════════
   GET /api/businesses/:businessId/recetas-elaborados
   Devuelve mapa { [insumoId]: { costoTotal, porciones, precioSugerido } }
   para todos los insumos elaborados con receta del negocio
══════════════════════════════════════════════════════════════ */
exports.getRecetasElaboradosMapa = async (req, res, next) => {
  try {
    const bizId = Number(req.params.businessId);
    if (!bizId) return res.status(400).json({ ok: false, error: 'invalid_params' });

    // Obtener el % costo ideal global de insumos del negocio como fallback
    const { rows: bizRows } = await pool.query(
      `SELECT (props->>'insumos_costo_ideal')::numeric AS insumos_costo_ideal
         FROM app_businesses WHERE id = $1 LIMIT 1`,
      [bizId]
    );
    const globalPct = Number(bizRows[0]?.insumos_costo_ideal || 30);

    const { rows } = await pool.query(
      `SELECT
         r.insumo_id,
         r.costo_total,
         r.porciones,
         -- Usar porcentaje_venta guardado, o el global del negocio como fallback
         COALESCE(NULLIF(r.porcentaje_venta, 0), $2) AS porcentaje_venta,
         CASE WHEN r.porciones > 0 AND COALESCE(NULLIF(r.porcentaje_venta, 0), $2) > 0
           THEN ROUND(
             (r.costo_total / r.porciones) /
             (COALESCE(NULLIF(r.porcentaje_venta, 0), $2) / 100.0),
             2
           )
           ELSE 0
         END AS precio_sugerido
       FROM recetas r
      WHERE r.business_id = $1
        AND r.active = TRUE
        AND r.insumo_id IS NOT NULL`,
      [bizId, globalPct]
    );

    const mapa = {};
    rows.forEach(r => {
      mapa[String(r.insumo_id)] = {
        costoTotal:     Number(r.costo_total),
        porciones:      Number(r.porciones),
        precioSugerido: Number(r.precio_sugerido),
        porcentajeVenta: Number(r.porcentaje_venta),
      };
    });

    return res.json({ ok: true, data: mapa });
  } catch (e) {
    console.error('[getRecetasElaboradosMapa]', e);
    next(e);
  }
};