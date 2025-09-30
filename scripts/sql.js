// scripts/sql.js
require('dotenv').config();
const pool = require('../config/db');

const sql = process.argv.slice(2).join(' ');
if (!sql) {
  console.error('Uso: node scripts/sql.js "<SQL>"');
  process.exit(1);
}

(async () => {
  try {
    const r = await pool.query(sql);
    console.log(r.rows);
  } catch (e) {
    console.error('ERROR:', e);
  } finally {
    process.exit(0);
  }
})();
