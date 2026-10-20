// db/scripts/inspect-maxirest-schema.js
//
// Diagnóstico de SOLO LECTURA — no modifica nada. Lista las tablas del
// schema `maxirest_14536_ramos` (la copia cruda de MaxiRest que carga el
// script Python del colega) con su cantidad de filas y columnas, para
// identificar cuáles son las de comprobantes/compras/ventas/artículos y
// diseñar el pipeline de ingesta automática normalizada.
//
// Uso: node db/scripts/inspect-maxirest-schema.js [filtro]
//   filtro opcional: substring para limitar qué tablas listar en detalle
'use strict';
require('dotenv').config();
const pool = require('../../config/db');

const SCHEMA = 'maxirest_14536_ramos';
const filtro = process.argv[2] || null;

async function main() {
  const { rows: tablas } = await pool.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = $1 ORDER BY table_name`,
    [SCHEMA]
  );
  console.log(`Schema ${SCHEMA}: ${tablas.length} tablas\n`);
  console.log(tablas.map(t => t.table_name).join(', '));

  const objetivo = filtro
    ? tablas.filter(t => t.table_name.toLowerCase().includes(filtro.toLowerCase()))
    : tablas;

  for (const { table_name } of objetivo) {
    const cols = await pool.query(
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
      [SCHEMA, table_name]
    );
    let count = null;
    try {
      const c = await pool.query(`SELECT COUNT(*)::int AS n FROM "${SCHEMA}"."${table_name}"`);
      count = c.rows[0].n;
    } catch (e) { count = `error: ${e.message}`; }
    console.log(`\n── ${table_name} (${count} filas) ──`);
    console.table(cols.rows);
  }

  await pool.end();
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
