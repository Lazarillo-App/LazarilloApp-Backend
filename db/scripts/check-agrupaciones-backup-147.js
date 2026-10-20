// db/scripts/check-agrupaciones-backup-147.js
//
// Diagnóstico de SOLO LECTURA — no modifica nada. Inspecciona la tabla
// `agrupaciones_backup_147` (nombre sospechoso: alguien la creó a mano,
// scopeada al negocio 147) y la compara contra la tabla real `agrupaciones`
// filtrada al mismo negocio.
//
// Uso: node db/scripts/check-agrupaciones-backup-147.js
'use strict';
require('dotenv').config();
const pool = require('../../config/db');

async function main() {
  const cols = await pool.query(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_name = 'agrupaciones_backup_147' ORDER BY ordinal_position`
  );
  console.log('── Columnas de agrupaciones_backup_147 ──');
  console.table(cols.rows);

  const totalBackup = await pool.query(`SELECT COUNT(*)::int AS total FROM agrupaciones_backup_147`);
  console.log('Filas en agrupaciones_backup_147:', totalBackup.rows[0].total);

  const sampleBackup = await pool.query(`SELECT * FROM agrupaciones_backup_147 ORDER BY 1 LIMIT 10`);
  console.log('── Primeras 10 filas del backup ──');
  console.table(sampleBackup.rows);

  const totalReal = await pool.query(`SELECT COUNT(*)::int AS total FROM agrupaciones WHERE business_id = 147`);
  console.log('\nFilas actuales en agrupaciones (business_id=147):', totalReal.rows[0].total);

  const sampleReal = await pool.query(`SELECT * FROM agrupaciones WHERE business_id = 147 ORDER BY id LIMIT 10`);
  console.log('── Primeras 10 filas actuales (agrupaciones, negocio 147) ──');
  console.table(sampleReal.rows);

  await pool.end();
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
