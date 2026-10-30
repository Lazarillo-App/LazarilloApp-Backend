// db/scripts/listar-pdv-de-schema.js
//
// Diagnóstico de SOLO LECTURA. Lista los valores distintos de `pdv` que
// hay hoy en un schema (container/comercio) — para encontrar el pdv de un
// negocio nuevo (ej. 214, subnegocio de 210) que todavía no está en
// PDV_MAP (maxiPipelinePurchasesSync.js). Un subnegocio tiene su PROPIO
// pdv aunque comparta schema con el negocio padre (mismo patrón que
// FCRAMOS/204 vs BAR/147).
//
// Uso: node db/scripts/listar-pdv-de-schema.js <schema>
'use strict';
require('dotenv').config();
const pool = require('../../config/db');

async function main() {
  const schema = process.argv[2];
  if (!schema) {
    console.log('Uso: node db/scripts/listar-pdv-de-schema.js <schema>  (container | comercio)');
    process.exit(1);
  }

  const { rows: tablas } = await pool.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = $1 AND table_name LIKE 'i25_compras_detalle_de_compras_%'
      ORDER BY table_name DESC`,
    [schema]
  );
  console.log(`Tablas i25 en ${schema}:`, tablas.map(t => t.table_name));

  for (const t of tablas) {
    const { rows } = await pool.query(
      `SELECT pdv, COUNT(*)::int AS filas, MIN(fecha) AS desde, MAX(fecha) AS hasta
         FROM "${schema}"."${t.table_name}"
        GROUP BY pdv ORDER BY pdv`
    );
    console.log(`\n=== ${schema}.${t.table_name} — pdv distintos ===`);
    console.table(rows);
  }

  await pool.end();
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
