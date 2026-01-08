// controllers/ventasCSVController.js
const {
  getSalesDailyCSV,
  getTopArticlesCSV,
  getSalesByArticleCSV,
  getSalesSummaryCSV,
  getSalesByGroupCSV,
} = require('../services/salesQueryCSV');

/**
 * GET /api/ventas-csv/daily
 * Ventas diarias (SOLO CSV)
 */
async function getDailyCSV(req, res, next) {
  try {
    const businessId = req.user?.active_business_id;
    const { from, to } = req.query;

    console.log('🔍 [ventasCSV] business_id:', businessId, 'user:', req.user?.id);

    if (!from || !to) {
      return res.status(400).json({ 
        error: 'missing_params', 
        message: 'Se requieren parámetros from y to (YYYY-MM-DD)' 
      });
    }

    const sales = await getSalesDailyCSV(businessId, { from, to });

    res.json({
      ok: true,
      source: 'csv',
      from,
      to,
      sales,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/ventas-csv/top-articles
 * Top artículos (SOLO CSV)
 */
async function getTopArticlesHandler(req, res, next) {
  try {
    const businessId = req.user?.active_business_id;
    const { from, to, limit } = req.query;

    if (!from || !to) {
      return res.status(400).json({ 
        error: 'missing_params', 
        message: 'Se requieren parámetros from y to' 
      });
    }

    const articles = await getTopArticlesCSV(businessId, { 
      from, 
      to, 
      limit: parseInt(limit) || 20 
    });

    res.json({
      ok: true,
      source: 'csv',
      from,
      to,
      articles,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/ventas-csv/by-article/:articleId
 * Ventas de un artículo específico (SOLO CSV)
 */
async function getByArticleHandler(req, res, next) {
  try {
    const businessId = req.user?.active_business_id;
    const articleId = parseInt(req.params.articleId);
    const { from, to } = req.query;

    if (!from || !to) {
      return res.status(400).json({ 
        error: 'missing_params', 
        message: 'Se requieren parámetros from y to' 
      });
    }

    const sales = await getSalesByArticleCSV(businessId, articleId, { from, to });

    res.json({
      ok: true,
      source: 'csv',
      article_id: articleId,
      from,
      to,
      sales,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/ventas-csv/summary
 * Resumen general (SOLO CSV)
 */
async function getSummaryHandler(req, res, next) {
  try {
    const businessId = req.user?.active_business_id;
    const { from, to } = req.query;

    if (!from || !to) {
      return res.status(400).json({ 
        error: 'missing_params', 
        message: 'Se requieren parámetros from y to' 
      });
    }

    const summary = await getSalesSummaryCSV(businessId, { from, to });

    res.json({
      ok: true,
      source: 'csv',
      from,
      to,
      summary,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/ventas-csv/by-group
 * Ventas por agrupación (SOLO CSV)
 */
async function getByGroupHandler(req, res, next) {
  try {
    const businessId = req.user?.active_business_id;
    const { from, to } = req.query;

    if (!from || !to) {
      return res.status(400).json({ 
        error: 'missing_params', 
        message: 'Se requieren parámetros from y to' 
      });
    }

    const groups = await getSalesByGroupCSV(businessId, { from, to });

    res.json({
      ok: true,
      source: 'csv',
      from,
      to,
      groups,
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getDailyCSV,
  getTopArticlesHandler,
  getByArticleHandler,
  getSummaryHandler,
  getByGroupHandler,
};