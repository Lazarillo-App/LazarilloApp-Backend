// db/scripts/create_second_admin.js
//
// Crea (o actualiza) una segunda cuenta app_admin, para poder entrar al mismo
// panel de super-admin con un email distinto. Corrige los bugs del script
// viejo create_admin_user.js: usaba role='admin' (no cumple el CHECK
// constraint real, que exige 'app_admin') y tenía una contraseña por defecto
// insegura.
//
// Uso (una sola vez, desde el Shell de Render — nunca commitear el email/
// password reales):
//   ADMIN_EMAIL=tu@email.com ADMIN_PASS=algo-seguro ADMIN_NAME="Tu Nombre" \
//     node db/scripts/create_second_admin.js
require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('../../config/db');

(async () => {
  const email = process.env.ADMIN_EMAIL;
  const name  = process.env.ADMIN_NAME || 'Admin';
  const pass  = process.env.ADMIN_PASS;

  if (!email || !pass) {
    throw new Error('Definí ADMIN_EMAIL y ADMIN_PASS como env vars antes de correr esto.');
  }
  if (pass.length < 6) {
    throw new Error('ADMIN_PASS debe tener al menos 6 caracteres.');
  }

  const hash = await bcrypt.hash(pass, 10);
  const { rows } = await pool.query(
    `INSERT INTO app_users (name, email, password_hash, role, status, account_status)
     VALUES ($1, lower($2), $3, 'app_admin', 'active', 'active')
     ON CONFLICT ((lower(email))) DO UPDATE
       SET role = 'app_admin', password_hash = EXCLUDED.password_hash, status = 'active', account_status = 'active'
     RETURNING id, email, role`,
    [name, email, hash]
  );

  console.log('Admin listo:', rows[0]);
  await pool.end();
})().catch((e) => {
  console.error('create_second_admin error:', e);
  process.exit(1);
});
