// db/scripts/inspect-maxi-pipeline-table.js
//
// Diagnóstico de SOLO LECTURA — no modifica nada. Muestra las columnas y
// unas filas de ejemplo de una tabla del pipeline nuevo del colega
// (schemas `container`/`comercio`, tablas i##/m# — ver memoria
// maxirest-sync-schema-147). Para diseñar la ingesta real hace falta ver
// la forma exacta de los datos antes de escribir cualquier mapeo.
//
// Uso: node db/scripts/inspect-maxi-pipeline-table.js <schema> <tabla> [limite]
//   node db/scripts/inspect-maxi-pipeline-table.js container i25_compras_detalle_de_compras_2026
//   node db/scripts/inspect-maxi-pipeline-table.js container i80_compras_detalle_de_pagos_2026 10
'use strict';
require('dotenv').config();
const pool = require('../../config/db');

// Solo letras/números/guión bajo — estos nombres vienen de un argumento de
// línea de comandos y van directo a un identificador SQL (no se puede
// parametrizar un nombre de tabla/schema), así que se valida antes de
// interpolar para no abrir la puerta a un identificador raro.
const ID_VALIDO = /^[a-zA-Z0-9_]+$/;

async function main() {
  const schema = process.argv[2];
  const tabla = process.argv[3];
  const limite = Number(process.argv[4]) || 5;

  if (!schema || !tabla || !ID_VALIDO.test(schema) || !ID_VALIDO.test(tabla)) {
    console.log('Uso: node db/scripts/inspect-maxi-pipeline-table.js <schema> <tabla> [limite]');
    process.exit(1);
  }

  const existe = await pool.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2`,
    [schema, tabla]
  );
  if (!existe.rows.length) {
    console.log(`No existe "${schema}"."${tabla}".`);
    const similares = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name`,
      [schema]
    );
    console.log(`Tablas disponibles en "${schema}":`);
    similares.rows.forEach((r) => console.log(`  ${r.table_name}`));
    await pool.end();
    return;
  }

  const cols = await pool.query(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
    [schema, tabla]
  );
  console.log(`=== Columnas de "${schema}"."${tabla}" ===`);
  console.table(cols.rows);

  const count = await pool.query(`SELECT COUNT(*)::int AS n FROM "${schema}"."${tabla}"`);
  console.log(`Filas totales: ${count.rows[0].n}`);

  const sample = await pool.query(`SELECT * FROM "${schema}"."${tabla}" LIMIT ${limite}`);
  console.log(`\n=== Primeras ${sample.rows.length} fila(s) ===`);
  sample.rows.forEach((r, i) => {
    console.log(`\n--- fila ${i + 1} ---`);
    console.log(JSON.stringify(r, null, 2));
  });

  await pool.end();
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
