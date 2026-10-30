// db/scripts/inspeccionar-sales-daily-items.js
//
// Diagnóstico de SOLO LECTURA. Antes de escribir el pipeline nuevo de
// ventas (services/maxiPipelineSalesSync.js) necesitamos confirmar el
// esquema REAL de producción de sales_daily / sales_daily_items /
// maxi_sales_daily / maxi_articles — los archivos de migración en este
// repo NO alcanzan (csvSalesImportService.js ya usa columnas `source`,
// `branch_id`, `created_at` en sales_daily_items que no aparecen en
// ninguna migración versionada, probablemente agregadas a mano).
// Mismo aprendizaje que compras: no asumir, confirmar antes de escribir.
//
// Uso: node db/scripts/inspeccionar-sales-daily-items.js [business_id]
'use strict';
require('dotenv').config();
const pool = require('../../config/db');

async function columnasDe(tabla) {
  const { rows } = await pool.query(
    `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position`,
    [tabla]
  );
  return rows;
}

async function constraintsDe(tabla) {
  const { rows } = await pool.query(
    `SELECT tc.constraint_name, tc.constraint_type,
            array_agg(kcu.column_name ORDER BY kcu.ordinal_position) AS columnas
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_name = tc.constraint_name AND kcu.table_name = tc.table_name
      WHERE tc.table_schema = 'public' AND tc.table_name = $1
        AND tc.constraint_type IN ('PRIMARY KEY', 'UNIQUE')
      GROUP BY tc.constraint_name, tc.constraint_type`,
    [tabla]
  );
  return rows;
}

async function main() {
  const businessId = process.argv[2] ? Number(process.argv[2]) : 147;

  for (const tabla of ['sales_daily', 'sales_daily_items', 'maxi_sales_daily', 'maxi_articles', 'maxi_article_map']) {
    const cols = await columnasDe(tabla);
    if (!cols.length) {
      console.log(`\n=== ${tabla}: NO EXISTE ===`);
      continue;
    }
    console.log(`\n=== Columnas de ${tabla} ===`);
    console.table(cols);

    const cons = await constraintsDe(tabla);
    console.log(`--- PK / UNIQUE de ${tabla} ---`);
    console.table(cons);
  }

  console.log(`\n=== Valores distintos de "source" en sales_daily_items (business_id=${businessId}) ===`);
  try {
    const { rows } = await pool.query(
      `SELECT source, COUNT(*)::int AS filas, MIN(day) AS desde, MAX(day) AS hasta
         FROM sales_daily_items WHERE business_id = $1 GROUP BY source`,
      [businessId]
    );
    console.table(rows);
  } catch (e) {
    console.log(`(no se pudo: ${e.message})`);
  }

  console.log(`\n=== Muestra sales_daily_items (business_id=${businessId}, últimas 10) ===`);
  try {
    const { rows } = await pool.query(
      `SELECT * FROM sales_daily_items WHERE business_id = $1 ORDER BY day DESC LIMIT 10`,
      [businessId]
    );
    console.table(rows);
  } catch (e) {
    console.log(`(no se pudo: ${e.message})`);
  }

  console.log(`\n=== Muestra maxi_articles (business_id=${businessId}, 5) ===`);
  try {
    const { rows } = await pool.query(
      `SELECT business_id, articulo_id, nombre, categoria, subrubro FROM maxi_articles WHERE business_id = $1 LIMIT 5`,
      [businessId]
    );
    console.table(rows);
  } catch (e) {
    console.log(`(no se pudo: ${e.message})`);
  }

  await pool.end();
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
