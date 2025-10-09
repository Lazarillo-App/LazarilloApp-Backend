// scripts/patch-agrupaciones.js
const pool = require('../../config/db');

async function main() {
  await pool.query(`ALTER TABLE agrupaciones
    ALTER COLUMN articulos SET DEFAULT '[]'::jsonb;`);

  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_agrupaciones_nombre
    ON agrupaciones (nombre);`);

  console.log('✅ Patch aplicado');
  await pool.end();
}

main().catch((e) => {
  console.error('❌ Error aplicando patch:', e);
  process.exit(1);
});
