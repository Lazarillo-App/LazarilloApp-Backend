// controllers/recetasElaboradosController.js
const pool = require('../config/db');
const { logAudit } = require('../services/audit/auditLog');
const { listObservaciones, addObservacion } = require('../services/recetaObservaciones');
const { getEffectiveRole } = require('../services/auth/accessControl');
const { snapshotRecetaElaborado, createOrUpdateProposal, propuestaAbiertaDe } = require('../services/recetaProposals');
const { writeElaboradoReceta } = require('../services/recetaWrite');

async function resolveRecetaIdElaborado(insumoId, bizId) {
  const { rows } = await pool.query(
    `SELECT id FROM recetas WHERE insumo_id = $1 AND business_id = $2 AND active = TRUE LIMIT 1`,
    [insumoId, bizId]
  );
  return rows[0]?.id || null;
}

/* ══════════════════════════════════════════════════════════════
   GET/POST /api/businesses/:businessId/insumos/:insumoId/receta/observaciones
══════════════════════════════════════════════════════════════ */
exports.listRecetaElaboradoObservaciones = async (req, res, next) => {
  try {
    const bizId = Number(req.params.businessId);
    const insumoId = Number(req.params.insumoId);
    if (!bizId || !insumoId) return res.status(400).json({ ok: false, error: 'invalid_params' });

    const recetaId = await resolveRecetaIdElaborado(insumoId, bizId);
    if (!recetaId) return res.status(404).json({ ok: false, error: 'receta_not_found' });

    const observaciones = await listObservaciones(recetaId);
    return res.json({ ok: true, observaciones });
  } catch (e) {
    console.error('[listRecetaElaboradoObservaciones]', e);
    next(e);
  }
};

exports.addRecetaElaboradoObservacion = async (req, res, next) => {
  try {
    const bizId = Number(req.params.businessId);
    const insumoId = Number(req.params.insumoId);
    const uid = req.user?.id;
    if (!bizId || !insumoId) return res.status(400).json({ ok: false, error: 'invalid_params' });

    const recetaId = await resolveRecetaIdElaborado(insumoId, bizId);
    if (!recetaId) return res.status(404).json({ ok: false, error: 'receta_not_found' });

    const observacion = await addObservacion({
      recetaId, businessId: bizId, userId: uid, texto: req.body?.texto,
      entityType: 'receta_elaborado', entityId: insumoId,
    });
    return res.status(201).json({ ok: true, observacion });
  } catch (e) {
    if (e.message === 'texto_requerido') return res.status(400).json({ ok: false, error: 'texto_requerido' });
    console.error('[addRecetaElaboradoObservacion]', e);
    next(e);
  }
};

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
         ri.merma, ri.merma_id, ri.merma_ids, ri.pedido, ri.secreto, ri.tipo_costo, ri.orden,
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

    const propuesta_abierta = await propuestaAbiertaDe(bizId, { insumoId }).catch(() => null);
    return res.json({
      ok: true,
      receta: { ...receta, items },
      insumos_costo_ideal: insumosConfigObjetivo,
      precio_sugerido: precioSugerido,
      costo_por_porcion: costoXPorcion,
      porciones: Number(receta.porciones),
      propuesta_abierta,
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
  try {
    const bizId = Number(req.params.businessId);
    const insumoId = Number(req.params.insumoId);
    const uid = req.user?.id;

    if (!bizId || !insumoId) {
      return res.status(400).json({ ok: false, error: 'invalid_params' });
    }
    if (!Array.isArray(req.body?.items)) {
      return res.status(400).json({ ok: false, error: 'items_must_be_array' });
    }

    const { rows: insumoRows } = await pool.query(
      `SELECT id, nombre, unidad_med, es_elaborado, es_elaborado_manual
         FROM insumos
        WHERE id = $1 AND business_id = $2`,
      [insumoId, bizId]
    );
    if (!insumoRows.length) {
      return res.status(404).json({ ok: false, error: 'insumo_not_found' });
    }
    const insumo = insumoRows[0];

    // ── Staff: no escribe directo — queda como propuesta a revisar ──
    const effectiveRole = await getEffectiveRole(uid, bizId);
    if (effectiveRole === 'staff') {
      const before = await snapshotRecetaElaborado(insumoId, bizId);
      const proposal = await createOrUpdateProposal({
        bizId, insumoId, uid, body: req.body, snapshotBefore: before,
        nombreParaAviso: req.user?.name || req.user?.email,
      });
      return res.json({ ok: true, pending: true, proposal });
    }

    const {
      receta, recetaCostos, savedItems,
      costoUnitarioDB, precioSugeridoDB, porcionesNum,
    } = await writeElaboradoReceta({ bizId, insumoId, uid, body: req.body, insumo });

    return res.json({
      ok: true,
      receta: { ...receta, ...recetaCostos, items: savedItems },
      costo_por_porcion: costoUnitarioDB,
      precio_sugerido: precioSugeridoDB,
      porciones: porcionesNum,
    });
  } catch (e) {
    console.error('[saveRecetaElaborado]', e);
    if (e.status) return res.status(e.status).json({ ok: false, error: e.message });
    next(e);
  }
};

/* ══════════════════════════════════════════════════════════════
   DELETE /api/businesses/:businessId/insumos/:insumoId/receta
══════════════════════════════════════════════════════════════ */
exports.deleteRecetaElaborado = async (req, res, next) => {
  try {
    const bizId = Number(req.params.businessId);
    const insumoId = Number(req.params.insumoId);
    const uid = req.user?.id || null;

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

    await logAudit(null, {
      userId: uid, businessId: bizId,
      entityType: 'receta_elaborado', entityId: insumoId,
      action: 'delete',
      diff: { after: { active: false } },
    });

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