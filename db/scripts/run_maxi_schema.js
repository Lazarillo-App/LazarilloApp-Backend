// scripts/run_maxi_schema.js
const fs = require('fs');
const pool = require('../../config/db');

(async () => {
  const sql = fs.readFileSync('./scripts/007_maxi_schema.sql', 'utf8');
  await pool.query(sql);
  console.log('007_maxi_schema OK');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
