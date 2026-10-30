// db/scripts/inspeccionar-i22-ventas.js
//
// Diagnóstico de SOLO LECTURA. Columnas de la tabla de ventas que se le
// pase (i22 o i12) + una muestra de filas, para evaluar construir la
// ingesta de ventas desde ahí (mismo patrón que compras/i25), en vez de
// depender del sync viejo que se cortó.
//
// Uso: node db/scripts/inspeccionar-i22-ventas.js <schema> <pdv> [prefijo_tabla]
'use strict';
require('dotenv').config();
const pool = require('../../config/db');

async function main() {
  const schema = process.argv[2] || 'container';
  const pdv = process.argv[3] || 'BAR';
  const prefijo = process.argv[4] || 'i22_ventas_detalladas';

  const { rows: tablas } = await pool.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = $1 AND table_name LIKE $2
      ORDER BY table_name DESC`,
    [schema, `${prefijo}_%`]
  );
  console.log(`Tablas i22 en ${schema}:`, tablas.map(t => t.table_name));
  if (!tablas.length) { await pool.end(); return; }

  const tabla = tablas[0].table_name;
  const { rows: cols } = await pool.query(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
    [schema, tabla]
  );
  console.log(`\n=== Columnas de ${schema}.${tabla} ===`);
  for (const c of cols) console.log(`  ${c.column_name} (${c.data_type})`);

  const { rows: muestra } = await pool.query(
    `SELECT * FROM "${schema}"."${tabla}" WHERE pdv = $1 ORDER BY fecha DESC LIMIT 5`,
    [pdv]
  );
  console.log(`\n=== Muestra (últimas 5, pdv=${pdv}) ===`);
  console.log(muestra);

  const { rows: rango } = await pool.query(
    `SELECT MIN(fecha) AS desde, MAX(fecha) AS hasta, COUNT(*)::int AS filas
       FROM "${schema}"."${tabla}" WHERE pdv = $1`,
    [pdv]
  );
  console.log('\n=== Rango de fechas ===');
  console.log(rango[0]);

  await pool.end();
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
