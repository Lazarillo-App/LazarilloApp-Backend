// db/scripts/inspeccionar-recetas-schema.js
//
// Diagnóstico de SOLO LECTURA. Columnas reales de `recetas` y `app_articles`
// en producción (las migraciones versionadas no alcanzan — varias columnas
// se agregaron a mano en Render Shell) — para diseñar el import masivo de
// paso a paso + foto desde archivos .txt/imagen por negocio.
//
// Uso: node db/scripts/inspeccionar-recetas-schema.js [business_id]
'use strict';
require('dotenv').config();
const pool = require('../../config/db');

async function columnasDe(tabla) {
  const { rows } = await pool.query(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
    [tabla]
  );
  return rows;
}

async function main() {
  const businessId = process.argv[2] ? Number(process.argv[2]) : 147;

  for (const tabla of ['recetas', 'app_articles']) {
    console.log(`\n=== Columnas de ${tabla} ===`);
    console.table(await columnasDe(tabla));
  }

  console.log(`\n=== Muestra app_articles (business_id=${businessId}, 5) — para ver qué campo es "código" ===`);
  const { rows: arts } = await pool.query(
    `SELECT * FROM app_articles WHERE business_id = $1 ORDER BY id LIMIT 5`,
    [businessId]
  );
  console.log(arts);

  console.log(`\n=== Muestra recetas (business_id=${businessId}, 3) ===`);
  const { rows: recs } = await pool.query(
    `SELECT * FROM recetas WHERE business_id = $1 LIMIT 3`,
    [businessId]
  );
  console.log(recs);

  await pool.end();
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
