// services/maxiArticleMapService.js
const pool = require('../config/db');

async function rebuildArticleMapFromAppArticles(businessId) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1) Limpiar el mapa de ese negocio
    await client.query(
      `
      DELETE FROM maxi_article_map
      WHERE business_id = $1
      `,
      [businessId]
    );

    // 2) Volcar todos los artículos internos como base del mapa
    await client.query(
      `
      INSERT INTO maxi_article_map (
        business_id,
        articulo_id,   -- PK NOT NULL
        article_id,    -- FK a app_articles(id)
        external_code,
        title
      )
      SELECT
        a.business_id,
        a.id          AS articulo_id,
        a.id          AS article_id,
        NULL          AS external_code,
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
