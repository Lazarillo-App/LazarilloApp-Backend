// scripts/create_admin_app_user.js
require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('../config/db');

async function ensureSchema() {
  // Crea tabla si no existe
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_users (
      id BIGSERIAL PRIMARY KEY,
      name TEXT,
      email TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      active_business_id BIGINT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);

  // Agrega columnas que falten
  await pool.query(`
    ALTER TABLE app_users
      ADD COLUMN IF NOT EXISTS role  TEXT NOT NULL DEFAULT 'owner',
      ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active',
      ADD COLUMN IF NOT EXISTS reset_token_hash TEXT NULL,
      ADD COLUMN IF NOT EXISTS reset_token_expires_at TIMESTAMP NULL;
  `);

  // Índice case-insensitive por email
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_indexes WHERE indexname = 'app_users_email_lower_idx'
      ) THEN
        CREATE UNIQUE INDEX app_users_email_lower_idx
          ON app_users (lower(email));
      END IF;
    END$$;
  `);
}

(async () => {
  try {
    await ensureSchema();

    const email = process.env.ADMIN_EMAIL || 'lazarillo.app2025@gmail.com';
    const name  = process.env.ADMIN_NAME  || 'Admin Lazarillo';
    const pass  = process.env.ADMIN_PASS  || 'AdminlazarilloApp';
    const hash  = await bcrypt.hash(pass, 10);

    const { rows: existing } = await pool.query(
      'SELECT id FROM app_users WHERE lower(email)=lower($1) LIMIT 1',
      [email]
    );

    if (existing[0]) {
      await pool.query(
        `UPDATE app_users
           SET name=$1, password_hash=$2, role='admin', status='active'
         WHERE id=$3`,
        [name, hash, existing[0].id]
      );
      console.log('✅ Admin actualizado en app_users:', email);
    } else {
      await pool.query(
        `INSERT INTO app_users(name, email, password_hash, role, status)
         VALUES ($1,$2,$3,'admin','active')`,
        [name, email.trim(), hash]
      );
      console.log('✅ Admin creado en app_users:', email);
    }
    console.log('   Credenciales ->', email, '/', pass);
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
