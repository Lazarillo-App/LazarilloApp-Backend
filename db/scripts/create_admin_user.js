// scripts/create_admin_user.js
require('dotenv').config();
const bcrypt = require('bcryptjs');

// === Carga robusta de DB (igual estilo que adminController) ===
let db = null;
(function resolveDb() {
  const tryPaths = ['../db', '../config/db', '../services/db', '../lib/db', './db'];
  for (const p of tryPaths) {
    try {
      const mod = require(p);
      if (mod && typeof mod.query === 'function') { db = mod; return; }
      if (mod && mod.pool && typeof mod.pool.query === 'function') { db = mod.pool; return; }
    } catch (_) {}
  }
  const { Pool } = require('pg');
  const opts = { connectionString: process.env.DATABASE_URL };
  if (String(process.env.PGSSLMODE || '').toLowerCase() === 'require') {
    opts.ssl = { rejectUnauthorized: false };
  }
  const pool = new Pool(opts);
  db = { query: (t, p) => pool.query(t, p) };
})();

(async () => {
  const email = process.env.ADMIN_EMAIL || 'admin@lazarillo.local';
  const name  = process.env.ADMIN_NAME  || 'Admin';
  const pass  = process.env.ADMIN_PASS  || 'changeme123';

  // Detecta si tu tabla usa password_hash o password (texto plano NO recomendado)
  const cols = (await db.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name='users'
  `)).rows.map(r => r.column_name);

  const hasHash = cols.includes('password_hash');
  const pwdCol  = hasHash ? 'password_hash' : (cols.includes('password') ? 'password' : null);
  if (!pwdCol) {
    throw new Error("No encuentro columna de password en 'users' (esperaba password_hash o password).");
  }

  const hash = hasHash ? bcrypt.hashSync(pass, 10) : pass;

  // Crea o actualiza el usuario como admin y activo
  const upsertSql = `
    INSERT INTO users(email, name, ${pwdCol}, role, status, created_at)
    VALUES ($1,$2,$3,'admin','active',NOW())
    ON CONFLICT (email) DO UPDATE SET
      name=EXCLUDED.name,
      ${pwdCol}=EXCLUDED.${pwdCol},
      role='admin',
      status='active'
    RETURNING id, email, role, status
  `;
  const { rows } = await db.query(upsertSql, [email, name, hash]);

  console.log('✅ Admin listo:', rows[0]);
  console.log('   Credenciales ->', email, '/', pass);
  process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
