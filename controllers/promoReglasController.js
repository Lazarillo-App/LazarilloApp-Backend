// controllers/promoReglasController.js
// Promociones atadas al precio de sus artículos (Diego 11/11/2026): las de regla 'off' (% off) y
// 'nxm' (llevás N, pagás M). Cuando cambia el precio de un artículo en la tabla, el front pide esta
// lista, recalcula el precio de las promos que lo usan con su regla y lo guarda.
'use strict';
const pool = require('../config/db');

// GET /api/businesses/:businessId/promos-reglas
// → { ok, promos: [{ articleId, regla, offPct, llevas, pagas, componentes: [{ articleId, cantidad }] }] }
exports.listar = async (req, res, next) => {
  try {
    const bizId = Number(req.params.businessId);
    if (!bizId) return res.status(400).json({ ok: false, error: 'invalid_params' });
    const { rows } = await pool.query(
      `SELECT r.article_id, r.promo_regla, r.promo_off_pct, r.promo_llevas, r.promo_pagas,
              COALESCE(json_agg(json_build_object('articleId', ri.article_ref_id, 'cantidad', ri.cantidad))
                FILTER (WHERE ri.article_ref_id IS NOT NULL AND ri.article_ref_id <> 0), '[]') AS componentes
         FROM recetas r
         LEFT JOIN receta_items ri ON ri.receta_id = r.id
        WHERE r.business_id = $1 AND r.active = TRUE AND r.promo_regla IN ('off', 'nxm')
        GROUP BY r.id`,
      [bizId]
    );
    res.json({
      ok: true,
      promos: rows.map((r) => ({
        articleId: Number(r.article_id),
        regla: r.promo_regla,
        offPct: r.promo_off_pct != null ? Number(r.promo_off_pct) : null,
        llevas: r.promo_llevas != null ? Number(r.promo_llevas) : null,
        pagas: r.promo_pagas != null ? Number(r.promo_pagas) : null,
        componentes: (r.componentes || []).map((c) => ({ articleId: Number(c.articleId), cantidad: Number(c.cantidad) || 0 })),
      })),
    });
  } catch (e) { next(e); }
};
