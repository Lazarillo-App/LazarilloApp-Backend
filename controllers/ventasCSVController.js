// controllers/ventasCSVController.js
const {
  getSalesDailyCSV,
  getTopArticlesCSV,
  getSalesByArticleCSV,
  getSalesSummaryCSV,
  getSalesByGroupCSV,
} = require('../services/salesQueryCSV');

function getBusinessId(req) {
  return (
    Number(req.user?.active_business_id) ||
    Number(req.businessId) ||
    Number(req?.business?.id) ||
    Number(req?.activeBusiness?.id) ||
    Number(req.headers['x-business-id']) ||
    31 // ✅ fallback temporal (podés sacarlo cuando esté todo bien)
  );
}

function requireFromTo(req, res) {
  const from = String(req.query.from || '').slice(0, 10);
  const to = String(req.query.to || '').slice(0, 10);

  if (!from || !to) {
    res.status(400).json({
      ok: false,
      error: 'missing_params',
      message: 'Se requieren parámetros from y to (YYYY-MM-DD)',
    });
    return null;
  }

  return { from, to };
}

/**
 * GET /api/ventas-csv/daily
 * Ventas diarias (SOLO CSV)
 */
async function getDailyCSV(req, res, next) {
  try {
    const businessId = getBusinessId(req);
    const range = requireFromTo(req, res);
    if (!range) return;

    const { from, to } = range;

    console.log('🔍 [daily] businessId:', businessId, 'from:', from, 'to:', to);
    console.log('🔍 [daily] req.user:', req.user);

    const sales = await getSalesDailyCSV(businessId, { from, to });

    console.log('📊 [daily] Query returned:', sales.length, 'rows');
    if (sales.length > 0) console.log('📊 [daily] First row:', sales[0]);

    res.json({ ok: true, source: 'csv', business_id: businessId, from, to, sales });
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
    const businessId = getBusinessId(req);
    const range = requireFromTo(req, res);
    if (!range) return;

    const { from, to } = range;
    const limit = Math.min(Math.max(parseInt(req.query.limit || '20', 10), 1), 200);

    console.log('🔍 [top-articles] businessId:', businessId, 'from:', from, 'to:', to, 'limit:', limit);

    const articles = await getTopArticlesCSV(businessId, { from, to, limit });

    console.log('📊 [top-articles] Query returned:', articles.length, 'rows');
    if (articles.length > 0) console.log('📊 [top-articles] First row:', articles[0]);

    res.json({ ok: true, source: 'csv', business_id: businessId, from, to, limit, articles });
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
    const businessId = getBusinessId(req);
    const range = requireFromTo(req, res);
    if (!range) return;

    const articleId = Number(req.params.articleId);
    if (!Number.isFinite(articleId) || articleId <= 0) {
      return res.status(400).json({ ok: false, error: 'invalid_article_id' });
    }

    const { from, to } = range;

    const sales = await getSalesByArticleCSV(businessId, articleId, { from, to });

    res.json({
      ok: true,
      source: 'csv',
      business_id: businessId,
      article_id: articleId,
      from,
      to,
      sales,
    });
  } catch (error) {
    console.error('❌ [by-article] Error:', error);
    next(error);
  }
}

/**
 * GET /api/ventas-csv/summary
 * Resumen general (SOLO CSV)
 */
async function getSummaryHandler(req, res, next) {
  try {
    const businessId = getBusinessId(req);
    const range = requireFromTo(req, res);
    if (!range) return;

    const { from, to } = range;

    console.log('🔍 [ventasCSV/summary] businessId:', businessId, 'user:', req.user);

    const summary = await getSalesSummaryCSV(businessId, { from, to });

    res.json({ ok: true, source: 'csv', business_id: businessId, from, to, summary });
  } catch (error) {
    console.error('❌ [summary] Error:', error);
    next(error);
  }
}

/**
 * GET /api/ventas-csv/by-group
 * Ventas por agrupación (SOLO CSV)
 */
async function getByGroupHandler(req, res, next) {
  try {
    const businessId = getBusinessId(req);
    const range = requireFromTo(req, res);
    if (!range) return;

    const { from, to } = range;

    console.log('🔍 [by-group] businessId:', businessId, 'from:', from, 'to:', to);

    const groups = await getSalesByGroupCSV(businessId, { from, to });

    console.log('📊 [by-group] Query returned:', groups.length, 'rows');
    if (groups.length > 0) console.log('📊 [by-group] First row:', groups[0]);

    res.json({ ok: true, source: 'csv', business_id: businessId, from, to, groups });
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
