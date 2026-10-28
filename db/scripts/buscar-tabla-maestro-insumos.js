// db/scripts/buscar-tabla-maestro-insumos.js
//
// Diagnóstico de SOLO LECTURA. Busca si el "informe 0" (listado de insumos
// de MaxiRest, con ENVASE1..3/NETO1..3 — el factor de conversión pack→unidad)
// ya está llegando a la base junto con i25/i80, antes de pedirle a Diego que
// lo agregue a la subida automática.
//
// Uso: node db/scripts/buscar-tabla-maestro-insumos.js
'use strict';
require('dotenv').config();
const pool = require('../../config/db');

async function main() {
  const { rows } = await pool.query(
    `SELECT table_schema, table_name
       FROM information_schema.tables
      WHERE table_schema IN ('container', 'comercio')
      ORDER BY table_schema, table_name`
  );
  console.log(`=== Todas las tablas en container/comercio (${rows.length}) ===\n`);
  for (const r of rows) console.log(`  ${r.table_schema}.${r.table_name}`);

  const candidatas = rows.filter((r) =>
    /insumo|m0|listado|^i0/i.test(r.table_name)
  );
  console.log(`\n=== Candidatas a "informe 0" / maestro de insumos (${candidatas.length}) ===`);
  for (const r of candidatas) console.log(`  ${r.table_schema}.${r.table_name}`);

  await pool.end();
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
