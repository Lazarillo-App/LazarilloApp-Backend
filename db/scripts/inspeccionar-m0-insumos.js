// db/scripts/inspeccionar-m0-insumos.js
//
// Diagnóstico de SOLO LECTURA. m0_listado_de_insumos_con_discontinuados ya
// llega automáticamente junto con i25/i80 (confirmado) — acá vemos sus
// columnas y una fila real (Coca 600, código 874) para confirmar que trae
// ENVASE1..3/NETO1..3 como dijo Diego, antes de armar el cruce con i25.
//
// Uso: node db/scripts/inspeccionar-m0-insumos.js <schema> [codigo]
'use strict';
require('dotenv').config();
const pool = require('../../config/db');

async function main() {
  const schema = process.argv[2] || 'container';
  const codigo = process.argv[3] ? Number(process.argv[3]) : 874; // Coca 600 por defecto

  const { rows: cols } = await pool.query(
    `SELECT column_name, data_type
       FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'm0_listado_de_insumos_con_discontinuados'
      ORDER BY ordinal_position`,
    [schema]
  );
  console.log(`=== Columnas de ${schema}.m0_listado_de_insumos_con_discontinuados ===`);
  for (const c of cols) console.log(`  ${c.column_name} (${c.data_type})`);

  // Buscar la columna de código real (puede llamarse distinto a "codigo").
  const colCodigo = cols.find((c) => /codigo/i.test(c.column_name))?.column_name || 'codigo';

  const { rows } = await pool.query(
    `SELECT * FROM "${schema}".m0_listado_de_insumos_con_discontinuados WHERE "${colCodigo}" = $1 LIMIT 3`,
    [codigo]
  );
  console.log(`\n=== Fila(s) con ${colCodigo}=${codigo} ===`);
  console.log(rows);

  await pool.end();
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
