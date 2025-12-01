// services/maxiArticleMapService.js
const pool = require('../config/db');

async function rebuildArticleMapFromAppArticles(businessId) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1) Limpiamos el mapa actual de ese negocio
    await client.query(
      'DELETE FROM maxi_article_map WHERE business_id = $1',
      [businessId]
    );

    // 2) Volcamos todos los artículos internos como mapa base
    await client.query(
      `
      INSERT INTO maxi_article_map (business_id, article_id, external_code, title)
      SELECT
        a.business_id,
        a.id          AS article_id,
        NULL          AS external_code,      -- por ahora lo dejamos null
        a.name        AS title
      FROM app_articles a
      WHERE a.business_id = $1
      `,
      [businessId]
    );

    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  rebuildArticleMapFromAppArticles,
};
