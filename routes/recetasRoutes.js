// routes/recetasRoutes.js
// Se monta en: /api/businesses/:businessId/articles/:articleId/receta
// desde businessRoutes o directamente en app.js

const express = require('express');
const router  = express.Router({ mergeParams: true }); // mergeParams para heredar :businessId y :articleId
const ctrl    = require('../controllers/recetasController');
const { authRequired }           = require('../middleware/authMiddleware');
const { requireBusinessAccessParam } = require('../middleware/requireBusinessAccess');

router.use(authRequired);

// GET    /api/businesses/:businessId/articles/:articleId/receta
router.get('/',    ctrl.getReceta);

// POST   /api/businesses/:businessId/articles/:articleId/receta  (create/update)
router.post('/',   ctrl.saveReceta);

// DELETE /api/businesses/:businessId/articles/:articleId/receta
router.delete('/', ctrl.deleteReceta);

router.post('/propagate-delete', async (req, res, next) => {
  try {
    const bizId     = Number(req.params.businessId);
    const articleId = Number(req.params.articleId);
    const siblings  = await getLinkSiblings(bizId, articleId);
    if (!siblings) return res.json({ ok: true, propagated: 0 });

    const targets = siblings.filter(s => s.sync_recipe !== false);
    for (const s of targets) {
      await pool.query(
        `UPDATE recetas SET active = FALSE, updated_at = NOW()
         WHERE article_id = $1 AND business_id = $2 AND active = TRUE`,
        [s.article_id, bizId]
      );
    }
    return res.json({ ok: true, propagated: targets.length });
  } catch (err) { next(err); }
});

module.exports = router;