// routes/recetasRoutes.js
// Se monta en: /api/businesses/:businessId/articles/:articleId/receta
// desde businessRoutes o directamente en app.js

const pool = require('../config/db');
const express = require('express');
const router  = express.Router({ mergeParams: true }); // mergeParams para heredar :businessId y :articleId
const ctrl    = require('../controllers/recetasController');
const { authRequired }           = require('../middleware/authMiddleware');
const { getLinkSiblings } = require('../services/linkPropagation');

router.use(authRequired);

// GET    /api/businesses/:businessId/articles/:articleId/receta
router.get('/',    ctrl.getReceta);

// POST   /api/businesses/:businessId/articles/:articleId/receta  (create/update)
router.post('/',   ctrl.saveReceta);

const { propagateRecipe } = require('../services/linkPropagation');
const recetasCtrl = require('../controllers/recetasController');

router.post('/propagate', async (req, res, next) => {
  try {
    const bizId     = Number(req.params.businessId);
    const articleId = Number(req.params.articleId);
    
    // Leer la receta guardada
    const { rows: recetaRows } = await pool.query(
      `SELECT r.*, 
              json_agg(ri.* ORDER BY ri.orden) FILTER (WHERE ri.id IS NOT NULL) AS items_json
         FROM recetas r
         LEFT JOIN receta_items ri ON ri.receta_id = r.id
        WHERE r.article_id = $1 AND r.business_id = $2 AND r.active = TRUE
        GROUP BY r.id`,
      [articleId, bizId]
    );
    
    if (!recetaRows.length) return res.json({ ok: false, error: 'Receta no encontrada' });
    
    const receta = recetaRows[0];
    const savedItems = receta.items_json || [];
    
    const result = await propagateRecipe({ bizId, articleId, receta, savedItems });
    return res.json({ ok: true, propagated: result?.count || 0 });
  } catch (err) {
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