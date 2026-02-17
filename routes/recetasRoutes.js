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

module.exports = router;