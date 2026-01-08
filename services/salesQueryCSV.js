// services/salesQueryCSV.js
const pool = require('../config/db');

/**
 * Queries temporales que SOLO usan source='csv'
 * Estas son copias simplificadas de las queries normales
 */

/**
 * Ventas diarias por rango de fechas (SOLO CSV)
 */
async function getSalesDailyCSV(businessId, { from, to }) {
  const { rows } = await pool.query(
    `
    SELECT 
      day,
      SUM(qty) as total_qty,
      SUM(amount) as total_amount,
      COUNT(DISTINCT article_id) as unique_articles
    FROM sales_daily_items
    WHERE business_id = $1
      AND source = 'csv'
      AND day BETWEEN $2 AND $3
    GROUP BY day
    ORDER BY day DESC
    `,
    [businessId, from, to]
  );
  
  return rows;
}

/**
 * Top artículos vendidos (SOLO CSV)
 */
async function getTopArticlesCSV(businessId, { from, to, limit = 20 }) {
  const { rows } = await pool.query(
    `
    SELECT 
      sdi.article_id,
      sdi.article_name,
      SUM(sdi.qty) as total_qty,
      SUM(sdi.amount) as total_amount,
      COUNT(DISTINCT sdi.day) as days_sold
    FROM sales_daily_items sdi
    WHERE sdi.business_id = $1
      AND sdi.source = 'csv'
      AND sdi.day BETWEEN $2 AND $3
      AND sdi.article_id IS NOT NULL
      -- ❌ ELIMINAR: AND sdi.article_id > 0
    GROUP BY sdi.article_id, sdi.article_name
    ORDER BY total_amount DESC
    LIMIT $4
    `,
    [businessId, from, to, limit]
  );
  
  return rows;
}

/**
 * Ventas por artículo específico (SOLO CSV)
 */
async function getSalesByArticleCSV(businessId, articleId, { from, to }) {
  const { rows } = await pool.query(
    `
    SELECT 
      day,
      article_id,
      article_name,
      qty,
      amount
    FROM sales_daily_items
    WHERE business_id = $1
      AND article_id = $2
      AND source = 'csv'
      AND day BETWEEN $3 AND $4
    ORDER BY day DESC
    `,
    [businessId, articleId, from, to]
  );
  
  return rows;
}

/**
 * Resumen general (SOLO CSV)
 */
async function getSalesSummaryCSV(businessId, { from, to }) {
  const { rows } = await pool.query(
    `
    SELECT 
      COUNT(DISTINCT day) as days_with_sales,
      COUNT(DISTINCT article_id) as unique_articles,
      SUM(qty) as total_units,
      SUM(amount) as total_revenue,
      MIN(day) as first_sale_day,
      MAX(day) as last_sale_day
    FROM sales_daily_items
    WHERE business_id = $1
      AND source = 'csv'
      AND day BETWEEN $2 AND $3
    `,
    [businessId, from, to]
  );
  
  return rows[0] || {};
}

/**
 * Ventas agrupadas por agrupación (SOLO CSV)
 */
async function getSalesByGroupCSV(businessId, { from, to }) {
  const { rows } = await pool.query(
    `
    SELECT 
      COALESCE(ag.nombre, 'Sin clasificar') as agrupacion_nombre,
      ag.id as agrupacion_id,
      COUNT(DISTINCT sdi.article_id) as articulos_count,
      SUM(sdi.qty) as total_qty,
      SUM(sdi.amount) as total_amount
    FROM sales_daily_items sdi
    LEFT JOIN agrupacion_articulos aa ON aa.articulo_id = sdi.article_id
    LEFT JOIN agrupaciones ag ON ag.id = aa.agrupacion_id AND ag.business_id = sdi.business_id
    WHERE sdi.business_id = $1
      AND sdi.source = 'csv'
      AND sdi.day BETWEEN $2 AND $3
    GROUP BY ag.id, ag.nombre
    ORDER BY total_amount DESC
    `,
    [businessId, from, to]
  );
  
  return rows;
}

module.exports = {
  getSalesDailyCSV,
  getTopArticlesCSV,
  getSalesByArticleCSV,
  getSalesSummaryCSV,
  getSalesByGroupCSV,
};