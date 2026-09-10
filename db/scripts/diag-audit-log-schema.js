// db/scripts/diag-audit-log-schema.js
//
// Diagnóstico: muestra las columnas de la tabla audit_log y sus últimas filas.
// audit_log no tiene migración en el repo (se creó a mano en algún momento), así
// que antes de construir un endpoint de lectura sobre ella hace falta confirmar
// su esquema real en la base de producción.
//
// Uso: node db/scripts/diag-audit-log-schema.js
'use strict';
require('dotenv').config();
const pool = require('../../config/db');

async function main() {
  const { rows: cols } = await pool.query(
    `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_name = 'audit_log'
      ORDER BY ordinal_position`
  );
  console.log('── Columnas de audit_log ──');
  console.log(cols);

  const { rows: sample } = await pool.query(`SELECT * FROM audit_log ORDER BY id DESC LIMIT 5`).catch(e => {
    console.log('(no se pudo ordenar por id, probando sin ORDER BY)', e.message);
    return pool.query(`SELECT * FROM audit_log LIMIT 5`);
  });
  console.log('\n── Últimas filas ──');
  console.log(sample);

  await pool.end();
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
