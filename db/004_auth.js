// db/004_auth.js
module.exports.up = async function up(pool) {
  const exec = (sql, params = []) => pool.query(sql, params);
  const execSafe = async (sql) => {
    try { await exec(sql); }
    catch (e) {
      // ignora objetos/índices/columnas ya existentes
      if (['42710', '42701', '23505', '42P07', '23503'].includes(e.code)) return;
      throw e;
    }
  };

  console.log('➡️ Ejecutando 004_auth...');

  // ============== USERS ==============
  await execSafe(`
    CREATE TABLE IF NOT EXISTS app_users (
      id                BIGSERIAL PRIMARY KEY,
      name              TEXT,
      email             TEXT NOT NULL,
      password_hash     TEXT NOT NULL,
      phone             TEXT,
      active_business_id BIGINT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  // endurecer por si existía sin campos
  await execSafe(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS name TEXT;`);
  await execSafe(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS email TEXT;`);
  await execSafe(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS password_hash TEXT;`);
  await execSafe(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS phone TEXT;`);
  await execSafe(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS active_business_id BIGINT;`);
  await execSafe(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();`);
  await execSafe(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();`);

  // índice único por lower(email) (expresión)
  await execSafe(`DROP INDEX IF EXISTS app_users_email_lower_key;`);
  await execSafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS app_users_email_lower_idx
    ON app_users ((lower(email)));
  `);

  // ============== BUSINESSES ==============
  await execSafe(`
    CREATE TABLE IF NOT EXISTS app_businesses (
      id         BIGSERIAL PRIMARY KEY,
      owner_id   BIGINT,
      name       TEXT NOT NULL,
      color_hex  TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  // si la tabla ya existía sin owner_id/otras, agregarlas
  await execSafe(`ALTER TABLE app_businesses ADD COLUMN IF NOT EXISTS owner_id BIGINT;`);
  await execSafe(`ALTER TABLE app_businesses ADD COLUMN IF NOT EXISTS name TEXT;`);
  await execSafe(`ALTER TABLE app_businesses ADD COLUMN IF NOT EXISTS color_hex TEXT;`);
  // 004_auth.js  (dentro de up(pool) después de crear app_businesses)
  await execSafe(`ALTER TABLE app_businesses ADD COLUMN IF NOT EXISTS brand_logo_url TEXT;`);
  await execSafe(`ALTER TABLE app_businesses ADD COLUMN IF NOT EXISTS brand_font TEXT;`);
  await execSafe(`ALTER TABLE app_businesses ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();`);
  await execSafe(`ALTER TABLE app_businesses ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();`);
  // --- en 004_auth.js, después de CREATE TABLE app_businesses ... ---
await execSafe(`ALTER TABLE app_businesses ADD COLUMN IF NOT EXISTS slug TEXT;`);
await execSafe(`ALTER TABLE app_businesses ADD COLUMN IF NOT EXISTS props JSONB NOT NULL DEFAULT '{}'::jsonb;`);
await execSafe(`CREATE UNIQUE INDEX IF NOT EXISTS app_businesses_slug_key ON app_businesses (slug);`);
await execSafe(`CREATE INDEX IF NOT EXISTS app_businesses_props_gin ON app_businesses USING gin (props);`);

  // FK owner_id → app_users(id)
  await execSafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM information_schema.table_constraints
        WHERE constraint_name = 'app_businesses_owner_fk'
      ) THEN
        ALTER TABLE app_businesses
          ADD CONSTRAINT app_businesses_owner_fk
          FOREIGN KEY (owner_id)
          REFERENCES app_users(id)
          ON DELETE SET NULL;
      END IF;
    END$$;
  `);

  // índice por owner_id
  await execSafe(`CREATE INDEX IF NOT EXISTS app_businesses_owner_idx ON app_businesses (owner_id);`);

  // ============== USER-BUSINESSES (N:N) ==============
  await execSafe(`
    CREATE TABLE IF NOT EXISTS user_businesses (
      id          BIGSERIAL PRIMARY KEY,
      user_id     BIGINT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      business_id BIGINT NOT NULL REFERENCES app_businesses(id) ON DELETE CASCADE,
      role        TEXT NOT NULL DEFAULT 'owner',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await execSafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS user_businesses_unique
    ON user_businesses (user_id, business_id);
  `);
  await execSafe(`CREATE INDEX IF NOT EXISTS user_businesses_user_idx ON user_businesses (user_id);`);
  await execSafe(`CREATE INDEX IF NOT EXISTS user_businesses_biz_idx  ON user_businesses (business_id);`);

  // ============== FK active_business_id → businesses.id ==============
  await execSafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM information_schema.table_constraints
        WHERE constraint_name = 'app_users_active_business_fk'
      ) THEN
        ALTER TABLE app_users
          ADD CONSTRAINT app_users_active_business_fk
          FOREIGN KEY (active_business_id)
          REFERENCES app_businesses(id)
          ON DELETE SET NULL;
      END IF;
    END$$;
  `);

  // ============== triggers updated_at ==============
  await execSafe(`
    CREATE OR REPLACE FUNCTION set_updated_at()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
  await execSafe(`DROP TRIGGER IF EXISTS trg_app_users_updated_at ON app_users;`);
  await execSafe(`
    CREATE TRIGGER trg_app_users_updated_at
    BEFORE UPDATE ON app_users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `);
  await execSafe(`DROP TRIGGER IF EXISTS trg_app_businesses_updated_at ON app_businesses;`);
  await execSafe(`
    CREATE TRIGGER trg_app_businesses_updated_at
    BEFORE UPDATE ON app_businesses
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `);

  console.log('✅ 004_auth: tablas app_users/app_businesses/user_businesses listas');
  console.log('✅ 004_auth OK');
};