// db/scripts/muestra-articulos-reales.js
// Diagnóstico de SOLO LECTURA. Muestra de app_articles con id POSITIVO
// (sincronizados de Maxi, no manuales/promo) — para ver qué forma tiene
// realmente `codigo` ahí, y compararlo contra maxi_articles.articulo_id.
// Uso: node db/scripts/muestra-articulos-reales.js <business_id>
'use strict';
require('dotenv').config();
const pool = require('../../config/db');

async function main() {
  const businessId = Number(process.argv[2]) || 147;
  const { rows } = await pool.query(
    `SELECT id, name, codigo, rubro, subrubro FROM app_articles
      WHERE business_id = $1 AND id > 0 ORDER BY id LIMIT 10`,
    [businessId]
  );
  console.log(`=== app_articles id>0 (business_id=${businessId}) ===`);
  console.table(rows);

  const { rows: maxi } = await pool.query(
    `SELECT articulo_id, nombre FROM maxi_articles WHERE business_id = $1 ORDER BY articulo_id LIMIT 10`,
    [businessId]
  );
  console.log(`\n=== maxi_articles (business_id=${businessId}) ===`);
  console.table(maxi);

  await pool.end();
}
main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
