// scripts/peek_maxi.js
require('dotenv').config();
const { Client } = require('pg');

(async () => {
  const bizId = Number(process.argv[2]);
  if (!bizId) { console.error('Uso: node scripts/peek_maxi.js <BUSINESS_ID>'); process.exit(1); }

  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const q = async (sql, params=[]) => (await client.query(sql, params)).rows;

  const total = await q(`SELECT COUNT(*)::int AS n FROM public.maxi_articles WHERE business_id=$1`, [bizId]);
  console.log(`Artículos en maxi_articles para business_id=${bizId}:`, total[0]?.n);

  const byCat = await q(`
    SELECT categoria, subrubro, COUNT(*)::int AS n
    FROM public.maxi_articles
    WHERE business_id=$1
    GROUP BY categoria, subrubro
    ORDER BY categoria, subrubro
  `, [bizId]);
  console.log('\nDistribución por categoría/subrubro (primeros 30):');
  byCat.slice(0,30).forEach(r => console.log(` - ${r.categoria} / ${r.subrubro}: ${r.n}`));
  if (byCat.length > 30) console.log(` ... (+${byCat.length-30} más)`);

  const sample = await q(`
    SELECT articulo_id, nombre, categoria, subrubro, precio, costo, updated_at
    FROM public.maxi_articles
    WHERE business_id=$1
    ORDER BY updated_at DESC
    LIMIT 20
  `, [bizId]);
  console.log('\nMuestra de filas recientes:');
  console.table(sample);

  // (Opcional) ver cuántos quedaron con defaults
  const defaults = await q(`
    SELECT COUNT(*)::int AS n
    FROM public.maxi_articles
    WHERE business_id=$1
      AND (categoria='Sin categoría' OR subrubro='Sin subrubro')
  `, [bizId]);
  console.log(`\nCon valores por defecto (revisar mapeo): ${defaults[0]?.n}`);

  await client.end();
})();
