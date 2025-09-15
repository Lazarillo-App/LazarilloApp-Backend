// scripts/clear_maxi_articles.js
require('dotenv').config();                // por si usás .env
const pool = require('../config/db');      // tu pool de PG

(async () => {
  try {
    const bizId = Number(process.argv[2]);
    if (!Number.isFinite(bizId)) {
      console.error('Uso: node scripts/clear_maxi_articles.js <BUSINESS_ID>');
      process.exit(1);
    }

    // (opcional) ver cuántos hay antes
    const { rows: before } = await pool.query(
      'SELECT COUNT(*)::int AS n FROM public.maxi_articles WHERE business_id = $1',
      [bizId]
    );
    console.log(`Antes: ${before[0].n} artículos`);

    const del = await pool.query(
      'DELETE FROM public.maxi_articles WHERE business_id = $1',
      [bizId]
    );
    console.log(`Eliminados: ${del.rowCount}`);

    // (opcional) verificar
    const { rows: after } = await pool.query(
      'SELECT COUNT(*)::int AS n FROM public.maxi_articles WHERE business_id = $1',
      [bizId]
    );
    console.log(`Después: ${after[0].n} artículos`);
  } catch (e) {
    console.error('Error borrando artículos:', e);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
