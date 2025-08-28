// db/004_auth.js
module.exports.up = async function up(pool) {
  const exec = (sql, params = []) => pool.query(sql, params);
  const execSafe = async (sql) => {
    try { await exec(sql); }
    catch (e) {
      // ignora: objeto/columna/índice/relación duplicada
      if (['42710','42701','23505','42P07'].includes(e.code)) return;
      throw e;
    }
  };

  console.log('➡️ Ejecutando 004_auth...');

  // users
  await execSafe(`
    CREATE TABLE IF NOT EXISTS app_users (
      id            BIGSERIAL PRIMARY KEY,
      name          TEXT,
      email         TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // único por lower(email) — índice con expresión (no constraint)
  await execSafe(`DROP INDEX IF EXISTS app_users_email_lower_key;`);
  await execSafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS app_users_email_lower_idx
    ON app_users ((lower(email)));
  `);

  // businesses
  await execSafe(`
    CREATE TABLE IF NOT EXISTS app_businesses (
      id         BIGSERIAL PRIMARY KEY,
      owner_id   BIGINT REFERENCES app_users(id) ON DELETE SET NULL,
      name       TEXT NOT NULL,
      color_hex  TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // relación N a N (si vas a permitir colaboradores luego)
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

  // campo en usuario para recordar “negocio activo”
  await execSafe(`ALTER TABLE app_users ADD COLUMN active_business_id BIGINT;`);
  await execSafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.constraint_column_usage
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

  console.log('✅ 004_auth: tablas app_users/app_businesses/user_businesses listas');
  console.log('✅ 004_auth OK');
};
