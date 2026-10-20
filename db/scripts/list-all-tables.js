// db/scripts/list-all-tables.js
//
// Diagnóstico de SOLO LECTURA — no modifica nada. Lista TODAS las tablas del
// schema public con su cantidad de filas, para detectar una tabla nueva que
// no sea parte del esquema conocido de la app (ej. una tabla ad-hoc que
// alguien haya creado para una carga puntual, en vez de insertar en las
// tablas existentes).
//
// Uso: node db/scripts/list-all-tables.js
'use strict';
require('dotenv').config();
const pool = require('../../config/db');

async function main() {
  const { rows } = await pool.query(`
    SELECT c.relname AS tabla,
           c.reltuples::bigint AS filas_aprox,
           pg_size_pretty(pg_total_relation_size(c.oid)) AS tamano
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
     ORDER BY c.relname
  `);
  console.log(`Total de tablas en public: ${rows.length}\n`);
  console.table(rows);
  await pool.end();
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
