// db/scripts/diagnosticar-ventas-articulo.js
//
// Diagnóstico de SOLO LECTURA. Para un artículo puntual (por su código
// visible en la tabla, ej. 3192), confirma: (a) a qué articulo_id de
// maxi_articles corresponde, (b) cuántas filas/total tiene en
// sales_daily_items para ese negocio, (c) qué trae crudo i12 para ese
// código en el schema correspondiente — para detectar un desajuste de
// matching como el que hubo que confirmar para 147.
//
// Uso: node db/scripts/diagnosticar-ventas-articulo.js <business_id> <codigo>
'use strict';
require('dotenv').config();
const pool = require('../../config/db');
const { PDV_MAP } = require('../../services/maxiPdvMap');

async function main() {
  const businessId = Number(process.argv[2]);
  const codigo = Number(process.argv[3]);
  if (!Number.isFinite(businessId) || !Number.isFinite(codigo)) {
    console.log('Uso: node db/scripts/diagnosticar-ventas-articulo.js <business_id> <codigo>');
    process.exit(1);
  }

  const { rows: maxiArt } = await pool.query(
    `SELECT articulo_id, nombre FROM maxi_articles WHERE business_id = $1 AND articulo_id = $2`,
    [businessId, codigo]
  );
  console.log('=== maxi_articles ===');
  console.table(maxiArt);

  const { rows: appArt } = await pool.query(
    `SELECT id, name, codigo FROM app_articles WHERE business_id = $1 AND id = $2`,
    [businessId, codigo]
  );
  console.log('=== app_articles (id = codigo) ===');
  console.table(appArt);

  const { rows: sdiResumen } = await pool.query(
    `SELECT source, COUNT(*)::int AS filas, SUM(qty)::numeric AS qty_total, SUM(amount)::numeric AS amount_total,
            MIN(day) AS desde, MAX(day) AS hasta
       FROM sales_daily_items WHERE business_id = $1 AND article_id = $2 GROUP BY source`,
    [businessId, codigo]
  );
  console.log('=== sales_daily_items (agrupado por source) ===');
  console.table(sdiResumen);

  const entry = Object.entries(PDV_MAP).find(([, v]) => v.businessId === businessId);
  if (entry) {
    const [pdv, { schema }] = entry;
    const { rows: tablas } = await pool.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = $1 AND table_name LIKE 'i12_ventas_por_articulo_ranking_detallado_por_dia_%'
        ORDER BY table_name DESC`,
      [schema]
    );
    let totalI12 = 0, filasI12 = 0;
    for (const t of tablas) {
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS filas, SUM(importe)::numeric AS total
           FROM "${schema}"."${t.table_name}" WHERE pdv = $1 AND codigo = $2`,
        [pdv, String(codigo)]
      );
      filasI12 += rows[0].filas;
      totalI12 += Number(rows[0].total) || 0;
      console.log(`  ${schema}.${t.table_name} (pdv=${pdv}, codigo=${codigo}): ${rows[0].filas} filas, $${rows[0].total}`);
    }
    console.log(`=== i12 crudo total: ${filasI12} filas, $${totalI12.toFixed(2)} ===`);
  } else {
    console.log(`Negocio ${businessId} no está en PDV_MAP`);
  }

  await pool.end();
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
