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
    const businessId = req.user?.active_business_id || 31;
    const { from, to } = req.query;

    console.log('🔍 [daily] businessId:', businessId, 'from:', from, 'to:', to);
    console.log('🔍 [daily] req.user:', req.user);

    if (!from || !to) {
      return res.status(400).json({ 
        error: 'missing_params', 
        message: 'Se requieren parámetros from y to (YYYY-MM-DD)' 
      });
    }

    const sales = await getSalesDailyCSV(businessId, { from, to });
    
    console.log('📊 [daily] Query returned:', sales.length, 'rows');
    if (sales.length > 0) {
      console.log('📊 [daily] First row:', sales[0]);
    }

    res.json({
      ok: true,
      source: 'csv',
      from,
      to,
      sales,
    });
  } catch (error) {
    console.error('❌ [daily] Error:', error);
    next(error);
  }
}

/**
 * GET /api/ventas-csv/top-articles
 * Top artículos (SOLO CSV)
 */
async function getTopArticlesHandler(req, res, next) {
  try {
    const businessId = req.user?.active_business_id || 31;
    const { from, to, limit } = req.query;

    console.log('🔍 [top-articles] businessId:', businessId, 'from:', from, 'to:', to, 'limit:', limit);

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

    console.log('📊 [top-articles] Query returned:', articles.length, 'rows');
    if (articles.length > 0) {
      console.log('📊 [top-articles] First row:', articles[0]);
    }

    res.json({
      ok: true,
      source: 'csv',
      from,
      to,
      articles,
    });
  } catch (error) {
    console.error('❌ [top-articles] Error:', error);
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
    // 🔧 TEMPORAL: hardcodear business_id
    const businessId = req.user?.active_business_id || 31;
    const { from, to } = req.query;

    console.log('🔍 [ventasCSV/summary] businessId:', businessId, 'user:', req.user);

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
    const businessId = req.user?.active_business_id || 31;
    const { from, to } = req.query;

    console.log('🔍 [by-group] businessId:', businessId, 'from:', from, 'to:', to);

    if (!from || !to) {
      return res.status(400).json({ 
        error: 'missing_params', 
        message: 'Se requieren parámetros from y to' 
      });
    }

    const groups = await getSalesByGroupCSV(businessId, { from, to });

    console.log('📊 [by-group] Query returned:', groups.length, 'rows');
    if (groups.length > 0) {
      console.log('📊 [by-group] First row:', groups[0]);
    }

    res.json({
      ok: true,
      source: 'csv',
      from,
      to,
      groups,
    });
  } catch (error) {
    console.error('❌ [by-group] Error:', error);
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
