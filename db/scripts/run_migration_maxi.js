// scripts/run_migration_maxi.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../../config/db');

(async () => {
  const file = path.join(__dirname, '007_maxi_schema.sql');
  const sql = fs.readFileSync(file, 'utf8');
  try {
    console.log('> Ejecutando 007_maxi_schema.sql ...');
    await pool.query(sql);
    console.log('✔ Migración OK');
  } catch (e) {
    console.error('✖ Migración FALLÓ:', e.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
