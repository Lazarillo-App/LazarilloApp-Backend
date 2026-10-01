// controllers/recetasController.js
const pool = require('../config/db');
const { propagateRecipe } = require('../services/linkPropagation');
const { logAudit } = require('../services/audit/auditLog');
const { listObservaciones, addObservacion } = require('../services/recetaObservaciones');
const { getEffectiveRole } = require('../services/auth/accessControl');
const { snapshotReceta, createOrUpdateProposal } = require('../services/recetaProposals');
const { writeArticleReceta } = require('../services/recetaWrite');

async function resolveRecetaId(articleId, bizId) {
  const { rows } = await pool.query(
    `SELECT id FROM recetas WHERE article_id = $1 AND business_id = $2 AND active = TRUE LIMIT 1`,
    [articleId, bizId]
  );
  return rows[0]?.id || null;
}

/* ══════════════════════════════════════════════════════════════
   GET/POST /api/businesses/:businessId/articles/:articleId/receta/observaciones
══════════════════════════════════════════════════════════════ */
exports.listRecetaObservaciones = async (req, res, next) => {
  try {
    const bizId = Number(req.params.businessId);
    const articleId = Number(req.params.articleId);
    if (!bizId || !articleId) return res.status(400).json({ ok: false, error: 'invalid_params' });

    const recetaId = await resolveRecetaId(articleId, bizId);
    if (!recetaId) return res.status(404).json({ ok: false, error: 'receta_not_found' });

    const observaciones = await listObservaciones(recetaId);
    return res.json({ ok: true, observaciones });
  } catch (e) {
    console.error('[listRecetaObservaciones]', e);
    next(e);
  }
};

exports.addRecetaObservacion = async (req, res, next) => {
  try {
    const bizId = Number(req.params.businessId);
    const articleId = Number(req.params.articleId);
    const uid = req.user?.id;
    if (!bizId || !articleId) return res.status(400).json({ ok: false, error: 'invalid_params' });

    const recetaId = await resolveRecetaId(articleId, bizId);
    if (!recetaId) return res.status(404).json({ ok: false, error: 'receta_not_found' });

    const observacion = await addObservacion({
      recetaId, businessId: bizId, userId: uid, texto: req.body?.texto,
      entityType: 'receta', entityId: articleId,
    });
    return res.status(201).json({ ok: true, observacion });
  } catch (e) {
    if (e.message === 'texto_requerido') return res.status(400).json({ ok: false, error: 'texto_requerido' });
    console.error('[addRecetaObservacion]', e);
    next(e);
  }
};

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
         r.notas, r.foto, r.fotos, r.notas_updated_at,
         r.rendimiento_unidad, r.rendimiento_peso, r.unidad_peso,
         r.metodo_coccion, r.temperatura, r.tiempo_min, r.pasos,
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
         COALESCE(ri.insumo_id, ri.supply_id)                            AS supply_id,
         COALESCE(i.nombre, ma.nombre, ri.nombre_insumo_maxi, ms.nombre) AS supply_nombre,
         COALESCE(i.unidad_med, ri.unidad, ms.medida)                    AS supply_medida,
         COALESCE(i.precio_ref, 0)                                       AS precio_ref_db,
         ri.cantidad, ri.unidad, ri.costo_unitario,
         ROUND(ri.cantidad * ri.costo_unitario, 4)               AS costo_total_item,
         ri.notas, ri.observaciones, ri.fotos_urls,
         ri.merma, ri.pedido, ri.tipo_costo, ri.orden, ri.merma_id, ri.merma_ids, ri.secreto,
         ri.codigo_maxi_insumo, ri.nombre_insumo_maxi,
         ri.article_ref_id,
         ri.updated_at
       FROM receta_items ri
       LEFT JOIN insumos i      ON i.id  = ri.insumo_id
       LEFT JOIN maxi_supplies ms ON ms.id = ri.supply_id
       -- Ítem-artículo (article_ref_id): nombre en vivo, no el snapshot congelado
       -- en nombre_insumo_maxi — sin esto, renombrar un artículo nunca se veía
       -- reflejado en las recetas que lo usan como ingrediente.
       LEFT JOIN maxi_articles ma ON ma.articulo_id = ri.article_ref_id AND ma.business_id = $2
      WHERE ri.receta_id = $1
      ORDER BY ri.orden ASC, ri.id ASC`,
      [receta.id, receta.business_id]
    );

    return res.json({ ok: true, receta: { ...receta, items } });
  } catch (e) {
    console.error('[getReceta]', e);
    next(e);
  }
};

exports.saveReceta = async (req, res, next) => {
  try {
    const bizId = Number(req.params.businessId);
    const articleId = Number(req.params.articleId);
    const uid = req.user?.id;

    if (!bizId || !articleId) {
      return res.status(400).json({ ok: false, error: 'invalid_params' });
    }
    if (!Array.isArray(req.body?.items)) {
      return res.status(400).json({ ok: false, error: 'items_must_be_array' });
    }

    // ── Staff: no escribe directo — queda como propuesta a revisar ──
    // (Vista Operación, Fase 3: ningún cambio de un Staff pisa la receta real
    // hasta que un admin/owner lo apruebe.)
    const effectiveRole = await getEffectiveRole(uid, bizId);
    if (effectiveRole === 'staff') {
      const before = await snapshotReceta(articleId, bizId);
      const proposal = await createOrUpdateProposal({
        bizId, articleId, uid, body: req.body, snapshotBefore: before,
        nombreParaAviso: req.user?.name || req.user?.email,
      });
      return res.json({ ok: true, pending: true, proposal });
    }

    console.log('[saveReceta] params:', { bizId, articleId, uid });
    const { receta, recetaCostos, savedItems } = await writeArticleReceta({
      bizId, articleId, uid, body: req.body,
    });

    return res.json({
      ok: true,
      receta: { ...receta, ...recetaCostos, items: savedItems },
    });
  } catch (e) {
    console.error('[saveReceta]', e);
    if (e.status) return res.status(e.status).json({ ok: false, error: e.message });
    next(e);
  }
};

exports.deleteReceta = async (req, res, next) => {
  try {
    const bizId = Number(req.params.businessId);
    const articleId = Number(req.params.articleId);
    const uid = req.user?.id || null;

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

    await logAudit(null, {
      userId: uid, businessId: bizId,
      entityType: 'receta', entityId: articleId,
      action: 'delete',
      diff: { after: { active: false } },
    });

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