// db/005_branches.js
module.exports.up = async function up(pool) {
  const exec = (sql, params = []) => pool.query(sql, params);
  const execSafe = async (sql) => {
    try { await exec(sql); }
    catch (e) {
      // ignorar “ya existe” / constraints previas
      if (['42710','42701','23505','42P07','23503'].includes(e.code)) return;
      throw e;
    }
  };

  console.log('➡️ Ejecutando 005_branches...');

  await execSafe(`
    CREATE TABLE IF NOT EXISTS app_branches (
      id           BIGSERIAL PRIMARY KEY,
      business_id  BIGINT NOT NULL REFERENCES app_businesses(id) ON DELETE CASCADE,
      name         TEXT NOT NULL,
      logo_url     TEXT,
      address      JSONB NOT NULL DEFAULT '{}'::jsonb,
      contacts     JSONB NOT NULL DEFAULT '{}'::jsonb,
      props        JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // idempotentes por si ya existía
  await execSafe(`ALTER TABLE app_branches ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();`);
  await execSafe(`CREATE INDEX IF NOT EXISTS app_branches_props_gin ON app_branches USING gin (props);`);

  // trigger updated_at (reutiliza tu función si ya existe)
  await execSafe(`
    CREATE OR REPLACE FUNCTION set_updated_at()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
  await execSafe(`DROP TRIGGER IF EXISTS trg_app_branches_updated_at ON app_branches;`);
  await execSafe(`
    CREATE TRIGGER trg_app_branches_updated_at
    BEFORE UPDATE ON app_branches
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `);

  console.log('✅ 005_branches OK');
};
