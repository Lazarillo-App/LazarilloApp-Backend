// routes/recetasRoutes.js
// Se monta en: /api/businesses/:businessId/articles/:articleId/receta
// desde businessRoutes o directamente en app.js

const pool = require('../config/db');
const express = require('express');
const router  = express.Router({ mergeParams: true }); // mergeParams para heredar :businessId y :articleId
const ctrl    = require('../controllers/recetasController');
const { authRequired }           = require('../middleware/authMiddleware');
const { getLinkSiblings } = require('../services/linkPropagation');
router.use((req, res, next) => {
  console.log('[recetasRoutes] hit:', req.method, req.path, req.params);
  next();
});

router.use(authRequired);

// GET    /api/businesses/:businessId/articles/:articleId/receta
router.get('/',    ctrl.getReceta);

// POST   /api/businesses/:businessId/articles/:articleId/receta  (create/update)
router.post('/',   ctrl.saveReceta);

// Agregar después de router.post('/', ctrl.saveReceta):
const { propagateRecipe } = require('../services/linkPropagation');

router.post('/propagate', async (req, res, next) => {
  try {
    const bizId     = Number(req.params.businessId);
    const articleId = Number(req.params.articleId);
    console.log('[propagate] bizId:', bizId, 'articleId:', articleId);

    // Leer receta + items guardados
    const { rows } = await pool.query(
      `SELECT r.id, r.nombre, r.porciones, r.porcentaje_venta, r.costo_total,
              r.notas, r.foto, r.notas_updated_at,
              COALESCE(
                json_agg(
                  json_build_object(
                    'insumo_id', ri.insumo_id,
                    'cantidad', ri.cantidad,
                    'unidad', ri.unidad,
                    'costo_unitario', ri.costo_unitario,
                    'observaciones', ri.observaciones,
                    'fotos_urls', ri.fotos_urls,
                    'merma', ri.merma,
                    'pedido', ri.pedido,
                    'tipo_costo', ri.tipo_costo,
                    'orden', ri.orden
                  ) ORDER BY ri.orden
                ) FILTER (WHERE ri.id IS NOT NULL),
                '[]'
              ) AS items_json
         FROM recetas r
         LEFT JOIN receta_items ri ON ri.receta_id = r.id
        WHERE r.article_id = $1 AND r.business_id = $2 AND r.active = TRUE
        GROUP BY r.id`,
      [articleId, bizId]
    );
     console.log('[propagate] rows encontradas:', rows.length);

    if (!rows.length) {
      return res.status(404).json({ ok: false, error: 'Receta no encontrada' });
    }

    const receta    = rows[0];
    const savedItems = rows[0].items_json || [];

    console.log(`[/propagate] art=${articleId} biz=${bizId} items=${savedItems.length}`);

    const result = await propagateRecipe({ bizId, articleId, receta, savedItems });

    console.log(`[/propagate] result:`, result);

    return res.json({ ok: true, propagated: result?.count || 0, to: result?.propagatedTo || [] });
  } catch (err) {
    console.error('[/propagate]', err);
    next(err);
  }
});

// DELETE /api/businesses/:businessId/articles/:articleId/receta
router.delete('/', ctrl.deleteReceta);

router.post('/propagate-delete', async (req, res, next) => {
  try {
    const bizId     = Number(req.params.businessId);
    const articleId = Number(req.params.articleId);

    const siblings = await getLinkSiblings(bizId, articleId);
    if (!siblings) return res.json({ ok: true, propagated: 0 });

    const targets = [];
    if (!targets.length) return res.json({ ok: true, propagated: 0 });

    for (const s of targets) {
      await pool.query(
        `UPDATE recetas SET active = FALSE, updated_at = NOW()
         WHERE article_id = $1 AND business_id = $2 AND active = TRUE`,
        [Number(s.article_id), bizId]
      );
      // Limpiar costo en insumos elaborados vinculados
      await pool.query(
        `UPDATE insumos
         SET costo_receta = 0, tiene_receta = FALSE, updated_at = NOW()
         WHERE id = $1 AND business_id = $2
           AND (es_elaborado = TRUE OR es_elaborado_manual = TRUE)`,
        [Number(s.article_id), bizId]
      );
    }

    console.log(`[propagate-delete] ${targets.length} recetas desactivadas desde artículo ${articleId}`);
    return res.json({ ok: true, propagated: targets.length });
  } catch (err) {
    next(err);
  }
});

module.exports = router;