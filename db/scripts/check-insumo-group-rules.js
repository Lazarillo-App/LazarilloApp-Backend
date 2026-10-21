// db/scripts/check-insumo-group-rules.js
//
// Diagnóstico de SOLO LECTURA — confirma si la tabla insumo_group_rules
// (que autoAssignNewInsumos.js YA lee para auto-asignar insumos nuevos,
// pero que ningún endpoint escribe todavía) existe en esta base.
//
// Uso: node db/scripts/check-insumo-group-rules.js
'use strict';
require('dotenv').config();
const pool = require('../../config/db');

async function main() {
  const { rows } = await pool.query(`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'insumo_group_rules'
    ) AS existe
  `);
  console.log('¿Existe insumo_group_rules?', rows[0].existe);
  if (rows[0].existe) {
    const cols = await pool.query(`
      SELECT column_name, data_type FROM information_schema.columns
       WHERE table_name = 'insumo_group_rules' ORDER BY ordinal_position
    `);
    console.table(cols.rows);
    const count = await pool.query(`SELECT COUNT(*)::int AS n FROM insumo_group_rules`);
    console.log('Filas:', count.rows[0].n);
  }
  await pool.end();
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
