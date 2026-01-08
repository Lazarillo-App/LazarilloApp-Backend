// routes/ventasCSVRoutes.js
const express = require('express');
const router = express.Router();
const {
  getDailyCSV,
  getTopArticlesHandler,
  getByArticleHandler,
  getSummaryHandler,
  getByGroupHandler,
} = require('../controllers/ventasCSVController');

// Todas las rutas usan auth que ya viene del guard global en app.js

router.get('/daily', getDailyCSV);
router.get('/top-articles', getTopArticlesHandler);
router.get('/by-article/:articleId', getByArticleHandler);
router.get('/summary', getSummaryHandler);
router.get('/by-group', getByGroupHandler);

module.exports = router;