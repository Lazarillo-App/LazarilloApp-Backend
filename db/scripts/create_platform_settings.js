// db/scripts/create_platform_settings.js
// Tabla clave-valor genérica para flags de plataforma (panel de super-admin).
// Arranca con 'maintenance' (modo mantenimiento global), pensada para poder
// sumar otros flags a futuro sin nueva migración.
//
// Uso: node db/scripts/create_platform_settings.js [--dry-run]
require('dotenv').config();
const pool = require('../../config/db');

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  const { rows } = await pool.query(
    `SELECT to_regclass('public.platform_settings') AS reg`
  );
  const yaExiste = !!rows[0]?.reg;
  console.log(`Tabla platform_settings ${yaExiste ? 'ya existe' : 'no existe todavía'}.`);

  if (dryRun) {
    await pool.end();
    return;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS platform_settings (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL DEFAULT '{}',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by BIGINT REFERENCES app_users(id) ON DELETE SET NULL
    )
  `);

  await pool.query(
    `INSERT INTO platform_settings(key, value) VALUES ('maintenance', '{"enabled": false}'::jsonb)
     ON CONFLICT (key) DO NOTHING`
  );

  console.log('Listo.');
  await pool.end();
}

main().catch((e) => {
  console.error('create_platform_settings error:', e);
  process.exit(1);
});
