// controllers/recetasElaboradosController.js
const pool = require('../config/db');
const { recalcularCostoReceta, recalcularCostoRecetas, propagarCostoInsumo } = require('../services/costoRecetaService');
const { factorConversion, normalizarCantidadUnidad } = require('../services/unidades');

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
         ri.id, ri.receta_id,
         COALESCE(ri.insumo_id, ri.supply_id)                    AS supply_id,
         COALESCE(i.nombre, ri.nombre_insumo_maxi)               AS supply_nombre,
         COALESCE(i.unidad_med, ri.unidad)                       AS supply_medida,
         COALESCE(i.precio_ref, 0)                               AS precio_ref_db,
         ri.cantidad, ri.unidad, ri.costo_unitario,
         ROUND(ri.cantidad * ri.costo_unitario, 4)               AS costo_total_item,
         ri.notas, ri.observaciones, ri.fotos_urls,
         ri.merma, ri.merma_id, ri.merma_ids, ri.pedido, ri.tipo_costo, ri.orden,
         ri.codigo_maxi_insumo, ri.nombre_insumo_maxi
       FROM receta_items ri
       LEFT JOIN insumos i ON i.id = ri.insumo_id
      WHERE ri.receta_id = $1
      ORDER BY ri.orden ASC, ri.id ASC`,
      [receta.id]
    );

    // ← primero cargar insumosConfigObjetivo
    let insumosConfigObjetivo = 30;
    try {
      const { rows: bizRows } = await pool.query(
        `SELECT props FROM app_businesses WHERE id = $1 LIMIT 1`, [bizId]
      );
      if (bizRows.length) {
        insumosConfigObjetivo = Number(bizRows[0].props?.insumos_costo_ideal ?? 30);
      }
    } catch { /* no crítico */ }

    // ← después calcular precio sugerido
    const costoXPorcion = Number(receta.costo_total) || 0;
    const pctVenta = Number(receta.porcentaje_venta) || insumosConfigObjetivo;
    const precioSugerido = pctVenta > 0 ? costoXPorcion / (pctVenta / 100) : 0;

    return res.json({
      ok: true,
      receta: { ...receta, items },
      insumos_costo_ideal: insumosConfigObjetivo,
      precio_sugerido: precioSugerido,
      costo_por_porcion: costoXPorcion,
      porciones: Number(receta.porciones),
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
      rendimientoUnidad = 'porcion',
      rendimientoPeso = null,
      unidadPeso = null,
      items = [],
      notas,
      foto,
      fotos,
      notasUpdatedAt,
    } = req.body || {};

    if (!Array.isArray(items)) {
      return res.status(400).json({ ok: false, error: 'items_must_be_array' });
    }

    // Normalizar fotos: array de hasta 6. Compatibilidad con `foto` single.
    // (mismo patrón que recetasController.js — acá faltaba por completo, por eso
    // la foto del insumo/elaborado nunca se guardaba.)
    let fotosArr = Array.isArray(fotos) ? fotos.filter(Boolean).slice(0, 6) : [];
    if (fotosArr.length === 0 && foto) fotosArr = [foto];
    const fotosJson = JSON.stringify(fotosArr);
    const fotoPrincipal = fotosArr[0] || null;

    // Normalizar y validar campos del rendimiento del lote
    const VALID_RU = ['porcion', 'u', 'lt', 'ml', 'kg', 'gr'];
    // Familia peso + volumen: el equivalente puede ser peso (gr/kg) o volumen (ml/lt)
    const VALID_UP = ['gr', 'kg', 'ml', 'lt'];
    const ruFinal = VALID_RU.includes(rendimientoUnidad) ? rendimientoUnidad : 'porcion';
    // El peso/volumen equivalente aplica cuando el rinde NO es directamente medible:
    // porcion o u. Si ya rinde en gr/kg/ml/lt, el lote es medible y no necesita equivalente.
    const aplicaPeso = ['porcion', 'u'].includes(ruFinal);
    // Peso y unidad van juntos: si falta cualquiera de los dos, no se guarda ninguno.
    const rpRaw = aplicaPeso && rendimientoPeso != null && Number(rendimientoPeso) > 0 ? Number(rendimientoPeso) : null;
    const upRaw = aplicaPeso && VALID_UP.includes(unidadPeso) ? unidadPeso : null;
    const rpFinal = (rpRaw != null && upRaw != null) ? rpRaw : null;
    const upFinal = (rpRaw != null && upRaw != null) ? upRaw : null;

    // Calcular costo total
    const costoTotal = items.reduce((acc, item) => {
      const cant = Number(item.cantidad || 0);
      if (cant === 0) return acc; // solo ignorar cero exacto
      return acc + (cant * Number(item.costoUnitario || 0));
    }, 0);

    // porcionesNum = rendimiento del lote. El costo por unidad del elaborado SÍ divide por porciones:
    // si rinde 20 y cuesta $261.104, 1 unidad/porción cuesta $13.055. Regla: elaborado con rendimiento > 1
    // siempre se costea por porción, nunca por el total del lote.
    const porcionesNum = Math.max(1, Number(porciones) || 1);
    const costoXPorcion = costoTotal / porcionesNum;   // costo de 1 unidad base del elaborado
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
          porcentaje_venta, costo_total, notas, foto, fotos, notas_updated_at,
          rendimiento_unidad, rendimiento_peso, unidad_peso,
          active, origen, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14, TRUE, 'manual', $15, NOW(), NOW())
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
        uid,
      ]
    );

    const receta = recetaRows[0];

    // El insumo pasa a ser elaborado por tener receta activa.
    await client.query(
      `UPDATE insumos SET es_elaborado = TRUE, updated_at = NOW()
        WHERE id = $1 AND business_id = $2 AND es_elaborado IS NOT TRUE`,
      [insumoId, bizId]
    );

    // Reemplazar items
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
      const fotosUrlsItem = Array.isArray(item.fotosUrls)
        ? item.fotosUrls.filter(u => typeof u === 'string' && u.startsWith('http'))
        : [];

      const { rows: itemRows } = await client.query(
        `INSERT INTO receta_items
           (receta_id, insumo_id, cantidad, unidad, costo_unitario, notas,
            observaciones, fotos_urls, merma, pedido, tipo_costo, orden, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), NOW())
         RETURNING *`,
        [receta.id, supplyId, cantidad, unidad, costoUnitario, notas,
          observaciones, fotosUrlsItem, merma, pedido, tipoCosto, orden]
      );

      savedItems.push({
        ...itemRows[0],
        supply_id: supplyId,
        supply_nombre: insumoCheck[0].nombre,
        supply_medida: insumoCheck[0].unidad_med,
        costo_total_item: Math.round(cantidad * costoUnitario * 10000) / 10000,
      });
    }

    // ── Materializar costos desde receta_items ya persistidos ──
    // Pisa costo_total con la suma real de DB y calcula costo_unitario
    // (÷porciones para porcion/u, ÷peso para gr/kg/ml/lt) y costo_total_con_merma.
    const recetaCostos = await recalcularCostoReceta(receta.id, client);
    const costoTotalDB    = Number(recetaCostos?.costo_total)    || costoTotal;
    const costoUnitarioDB = Number(recetaCostos?.costo_unitario) || costoXPorcion;

    // ── Actualizar precio_ref y costo_receta en el insumo elaborado ──
    // precio_ref = costo UNITARIO correcto (contempla rendimiento por peso,
    // que el cálculo viejo por porciones ignoraba → arreglo del $/porcion mal
    // etiquetado cuando el elaborado rinde en gr/kg/ml/lt).
    // costo_receta = costo TOTAL del lote (informativo).
    await client.query(
      `UPDATE insumos
          SET precio_ref   = $1,
              costo_receta = $2,
              tiene_receta = TRUE,
              updated_at   = NOW()
        WHERE id = $3 AND business_id = $4`,
      [
        Math.round(costoUnitarioDB * 1000000) / 1000000, // precio_ref = unitario
        Math.round(costoTotalDB    * 1000)    / 1000,    // costo_receta = total
        insumoId, bizId,
      ]
    );

// ── Propagación: recalcular recetas que usan este elaborado como ingrediente ──
    // El rendimiento cambió → su costo_unitario cambió → actualizar los items que
    // lo referencian (convertido a la unidad de cada item) y recalcular esas recetas.
    const rendUnidElab = String(recetaCostos?.rendimiento_unidad || ruFinal || 'porcion').toLowerCase();
    // Unidad base en la que está expresado costoUnitarioDB:
    //  - porcion/u → 'u' (no se convierte por peso)
    //  - gr/kg/ml/lt → esa unidad medible
    const unidadBaseElab = ['gr','kg','ml','lt'].includes(rendUnidElab) ? rendUnidElab : 'u';
    const { rows: itemsAfectados } = await client.query(
      `SELECT ri.id, ri.receta_id, ri.unidad
         FROM receta_items ri
         JOIN recetas r ON r.id = ri.receta_id
        WHERE ri.insumo_id = $1
          AND r.business_id = $2
          AND ri.receta_id <> $3`,
      [insumoId, bizId, receta.id]
    );
    for (const it of itemsAfectados) {
      const unidadItem = String(it.unidad || unidadBaseElab || 'u').toLowerCase().trim();
      let nuevoCosto;
      if (unidadBaseElab === 'u') {
        // Elaborado por porción/unidad: el costo_unitario es por porción, sin conversión de peso
        nuevoCosto = costoUnitarioDB;
      } else {
        // Elaborado medible: convertir de la unidad base a la unidad del item
        const factor = factorConversion(unidadBaseElab, unidadItem);
        nuevoCosto = factor > 0 ? costoUnitarioDB / factor : costoUnitarioDB;
      }
      await client.query(
        `UPDATE receta_items SET costo_unitario = $1, updated_at = NOW() WHERE id = $2`,
        [Number(nuevoCosto.toFixed(6)), it.id]
      );
    }
    const recetasAfectadas = [...new Set(itemsAfectados.map(it => it.receta_id))];
    if (recetasAfectadas.length) {
      await recalcularCostoRecetas(recetasAfectadas, client);
    }

    // ── Propagación en cascada: este elaborado cambió su costo/rendimiento →
    // recalcular todas las recetas que lo usan (y elaborados anidados hacia arriba).
    await propagarCostoInsumo(insumoId, bizId, client);

    // Recalcular sugerido con el unitario materializado (correcto para peso)
    const precioSugeridoDB = porcentajeNum > 0 ? costoUnitarioDB / (porcentajeNum / 100) : 0;
    await client.query('COMMIT');

    const { invalidateCacheForBiz } = require('../middleware/cacheJson');
    invalidateCacheForBiz(bizId);

    console.log(`✅ [saveRecetaElaborado] Insumo=${insumoId} | Biz=${bizId} | Costo/u=$${costoXPorcion.toFixed(4)} | PrecioSug=$${precioSugerido.toFixed(4)}`);

    return res.json({
      ok: true,
      receta: { ...receta, ...recetaCostos, items: savedItems },
      costo_por_porcion: costoUnitarioDB,
      precio_sugerido: precioSugeridoDB,
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
              es_elaborado = FALSE,
              updated_at   = NOW()
        WHERE id = $1 AND business_id = $2`,
      [insumoId, bizId]
    );

    const { invalidateCacheForBiz } = require('../middleware/cacheJson');
    invalidateCacheForBiz(bizId);

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
         r.rendimiento_unidad,
         r.rendimiento_peso,
         r.unidad_peso,
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
        costoTotal: Number(r.costo_total),
        porciones: Number(r.porciones),
        rendimientoUnidad: r.rendimiento_unidad || 'porcion',
        rendimientoPeso: r.rendimiento_peso != null ? Number(r.rendimiento_peso) : null,
        unidadPeso: r.unidad_peso || null,
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