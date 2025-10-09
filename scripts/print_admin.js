require('dotenv').config();
const pool = require('../config/db');

(async () => {
  const email = process.env.ADMIN_EMAIL || 'lazarillo.app2025@gmail.com';
  const { rows } = await pool.query(
    `SELECT id, email, role, status, created_at
     FROM app_users WHERE lower(email)=lower($1)`, [email]);
  console.log('DB:', process.env.PGDATABASE || '(from URL)');
  console.log('Rows:', rows);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
