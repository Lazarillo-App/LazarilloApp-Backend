// scripts/patch-agrupaciones-timestamps.js
require('dotenv').config({ path: process.env.DOTENV_CONFIG_PATH || '.env' });
const { Pool } = require('pg');

(async () => {
  const pg = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PG_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  });

  const sql = `
    ALTER TABLE agrupaciones
      ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT NOW(),
      ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT NOW();

    CREATE OR REPLACE FUNCTION set_updated_at()
    RETURNS trigger AS $$
    BEGIN
      NEW.updated_at := NOW();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS agrupaciones_set_updated_at ON agrupaciones;
    CREATE TRIGGER agrupaciones_set_updated_at
    BEFORE UPDATE ON agrupaciones
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `;

  try {
    await pg.query(sql);
    console.log('✅ "agrupaciones" parcheada (timestamps + trigger)');
  } catch (e) {
    console.error('❌ Error parcheando:', e);
    process.exit(1);
  } finally {
    await pg.end();
  }
})();
