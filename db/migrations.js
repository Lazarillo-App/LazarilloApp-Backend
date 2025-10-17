// db/migrations.js
const fs = require('fs');
const path = require('path');
const pool = require('../config/db');

const m004 = require('../db/migrations/004_auth');
const m005 = require('../db/migrations/005_business_branding');
const m008 = require('../db/migrations/008_agrupaciones_multitenant');

async function runMigrations() {
  const exec = (sql, params = []) => pool.query(sql, params);
  const execSafe = async (sql, params = []) => {
    try { await exec(sql, params); }
    catch (e) {
      // 42710 duplicate_object, 42701 duplicate_column, 23505 unique_violation,
      // 42P07 duplicate_table, 23503 fk_violation (a veces inofensiva en idempotentes)
      if (['42710', '42701', '23505', '42P07', '23503'].includes(e.code)) return;
      throw e;
    }
  };

  console.log('📂 Usando base de datos PG:', process.env.PGDATABASE || '(desconocido)');

  // ===== Extensiones necesarias =====
  await execSafe(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);
  await execSafe(`CREATE EXTENSION IF NOT EXISTS citext;`);
  await execSafe(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`); // para gen_random_uuid si lo usás

  // ===== Núcleo (JS migrations existentes) =====
  await m004.up(pool);  // auth base
  await m005.up(pool);  // branding / businesses bits
  await m008.up(pool);  // agrupaciones multitenant (agrega business_id, etc.)

  // ===== app_users: role/status/reset + email único case-insensitive =====
  await execSafe(`
    ALTER TABLE app_users
      ADD COLUMN IF NOT EXISTS role   TEXT NOT NULL DEFAULT 'owner',
      ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active',
      ADD COLUMN IF NOT EXISTS reset_token_hash TEXT NULL,
      ADD COLUMN IF NOT EXISTS reset_token_expires_at TIMESTAMPTZ NULL;
  `);
  await execSafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_indexes WHERE indexname = 'app_users_email_lower_idx'
      ) THEN
        CREATE UNIQUE INDEX app_users_email_lower_idx ON app_users (lower(email));
      END IF;
    END$$;
  `);

  // =====================================================================
  // 1) INSUMOS
  // =====================================================================
  await execSafe(`
    CREATE TABLE IF NOT EXISTS insumos (
      id                BIGSERIAL PRIMARY KEY,
      codigo_maxi       TEXT UNIQUE,
      nombre            TEXT NOT NULL DEFAULT '',
      unidad_med        TEXT,
      precio_ref        NUMERIC(14,2),
      rubro             TEXT,
      envase            TEXT,
      vencimiento       DATE,
      resumen           TEXT,
      cant_ingredientes INT,
      agrupacion_base   TEXT,
      costo_ref         NUMERIC(14,2),
      nota              TEXT,
      origen            TEXT DEFAULT 'manual',
      activo            BOOLEAN NOT NULL DEFAULT TRUE,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await execSafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name='insumos' AND column_name='codigo_mostrar'
      ) THEN
        ALTER TABLE insumos
        ADD COLUMN codigo_mostrar TEXT
        GENERATED ALWAYS AS (
          COALESCE(NULLIF(BTRIM(codigo_maxi), ''), 'INS-' || id)
        ) STORED;
      END IF;
    END$$;
  `);
  await execSafe(`CREATE UNIQUE INDEX IF NOT EXISTS insumos_codigo_maxi_key ON insumos (codigo_maxi);`);
  await execSafe(`CREATE INDEX IF NOT EXISTS insumos_nombre_trgm ON insumos USING gin (nombre gin_trgm_ops);`);
  await execSafe(`CREATE INDEX IF NOT EXISTS insumos_activo_idx ON insumos (activo);`);
  await execSafe(`CREATE INDEX IF NOT EXISTS insumos_codigo_mostrar_trgm ON insumos USING gin (codigo_mostrar gin_trgm_ops);`);

  // =====================================================================
  // 2) Presentaciones por insumo
  // =====================================================================
  await execSafe(`
    CREATE TABLE IF NOT EXISTS insumo_presentaciones (
      id              BIGSERIAL PRIMARY KEY,
      insumo_id       BIGINT NOT NULL REFERENCES insumos(id) ON DELETE CASCADE,
      unidad          TEXT   NOT NULL,
      cantidad        NUMERIC(14,4) NOT NULL,
      precio          NUMERIC(14,2) NOT NULL,
      unidad_base     TEXT   NOT NULL,
      factor_base     NUMERIC(14,6) NOT NULL,
      precio_unitario NUMERIC(14,6) GENERATED ALWAYS AS
        (CASE WHEN (cantidad * factor_base) > 0
              THEN precio / (cantidad * factor_base)
              ELSE NULL END) STORED,
      activo          BOOLEAN NOT NULL DEFAULT TRUE,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await execSafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='pres_unidad_check') THEN
        ALTER TABLE insumo_presentaciones
        ADD CONSTRAINT pres_unidad_check
        CHECK (unidad IN ('kg','g','lt','ml','un'));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='pres_unidad_base_check') THEN
        ALTER TABLE insumo_presentaciones
        ADD CONSTRAINT pres_unidad_base_check
        CHECK (unidad_base IN ('kg','g','lt','ml','un'));
      END IF;
    END$$;
  `);
  await execSafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS insumo_presentaciones_unique_idx
    ON insumo_presentaciones (insumo_id, unidad, cantidad);
  `);
  await execSafe(`CREATE INDEX IF NOT EXISTS pres_insumo_idx ON insumo_presentaciones (insumo_id);`);
  await execSafe(`CREATE INDEX IF NOT EXISTS pres_unidad_idx ON insumo_presentaciones (unidad, activo);`);

  // =====================================================================
  // 3) Grupos de insumos
  // =====================================================================
  await execSafe(`
    CREATE TABLE IF NOT EXISTS insumo_grupos (
      id           BIGSERIAL PRIMARY KEY,
      cliente_id   BIGINT,
      nombre       TEXT NOT NULL,
      descripcion  TEXT,
      parent_id    BIGINT REFERENCES insumo_grupos(id) ON DELETE SET NULL,
      orden        INT NOT NULL DEFAULT 0,
      activo       BOOLEAN NOT NULL DEFAULT TRUE,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await execSafe(`
    CREATE TABLE IF NOT EXISTS insumo_grupo_items (
      id           BIGSERIAL PRIMARY KEY,
      grupo_id     BIGINT NOT NULL REFERENCES insumo_grupos(id) ON DELETE CASCADE,
      insumo_id    BIGINT NOT NULL REFERENCES insumos(id) ON DELETE CASCADE,
      cliente_id   BIGINT,
      orden        INT NOT NULL DEFAULT 0,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await execSafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='insumo_grupos_cliente_nombre_key') THEN
        CREATE UNIQUE INDEX IF NOT EXISTS idx_igrupos_cliente_nombre
          ON insumo_grupos (cliente_id, nombre);
        ALTER TABLE insumo_grupos
          ADD CONSTRAINT insumo_grupos_cliente_nombre_key
          UNIQUE USING INDEX idx_igrupos_cliente_nombre;
      END IF;
    END$$;
  `);
  await execSafe(`CREATE INDEX IF NOT EXISTS ig_cliente_idx ON insumo_grupos (cliente_id, activo);`);
  await execSafe(`CREATE INDEX IF NOT EXISTS ig_parent_idx ON insumo_grupos (parent_id);`);
  await execSafe(`CREATE UNIQUE INDEX IF NOT EXISTS insumo_grupo_items_unique_idx ON insumo_grupo_items (grupo_id, insumo_id);`);
  await execSafe(`CREATE INDEX IF NOT EXISTS igi_grupo_idx ON insumo_grupo_items (grupo_id, orden);`);
  await execSafe(`CREATE INDEX IF NOT EXISTS igi_cliente_idx ON insumo_grupo_items (cliente_id);`);

  // =====================================================================
  // 4) AGRUPACIONES (multitenant + citext)
  // =====================================================================
  await execSafe(`
    CREATE TABLE IF NOT EXISTS agrupaciones (
      id          SERIAL PRIMARY KEY,
      business_id INT NOT NULL,
      nombre      citext NOT NULL,
      articulos   JSONB  NOT NULL DEFAULT '[]'::jsonb,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  // asegurar business_id si faltara (raro)
  await execSafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='agrupaciones' AND column_name='business_id'
      ) THEN
        ALTER TABLE agrupaciones ADD COLUMN business_id INT NOT NULL DEFAULT 0;
        ALTER TABLE agrupaciones ALTER COLUMN business_id DROP DEFAULT;
      END IF;
    END$$;
  `);
  // asegurar jsonb
  await execSafe(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name='agrupaciones' AND column_name='articulos' AND data_type <> 'jsonb'
      ) THEN
        ALTER TABLE agrupaciones
          ALTER COLUMN articulos TYPE jsonb
          USING CASE
            WHEN articulos IS NULL OR btrim(articulos::text) = '' THEN '[]'::jsonb
            ELSE articulos::jsonb
          END;
      END IF;
    END$$;
  `);
  await execSafe(`ALTER TABLE agrupaciones ALTER COLUMN articulos SET DEFAULT '[]'::jsonb;`);
  await execSafe(`UPDATE agrupaciones SET articulos = '[]'::jsonb WHERE articulos IS NULL;`);

  // limpiar constraints viejas por nombre & re-crear únicas correctas
  await execSafe(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.table_constraints
        WHERE table_name='agrupaciones' AND constraint_name='agrupaciones_nombre_key'
      ) THEN
        ALTER TABLE agrupaciones DROP CONSTRAINT agrupaciones_nombre_key;
      END IF;
    END$$;
  `);
  await execSafe(`CREATE UNIQUE INDEX IF NOT EXISTS ux_agrupaciones_biz_nombre ON agrupaciones (business_id, nombre);`);
  await execSafe(`CREATE INDEX IF NOT EXISTS ix_agrupaciones_biz ON agrupaciones (business_id);`);
  await execSafe(`CREATE INDEX IF NOT EXISTS agrupaciones_nombre_trgm ON agrupaciones USING gin (nombre gin_trgm_ops);`);
  await execSafe(`CREATE INDEX IF NOT EXISTS agrupaciones_articulos_gin ON agrupaciones USING gin (articulos);`);

  // =====================================================================
  // 5) EXCLUSIONES POR AGRUPACIÓN (multitenant): saneo + índices
  // =====================================================================
  await execSafe(`
    CREATE TABLE IF NOT EXISTS agrupacion_exclusiones (
      id             SERIAL PRIMARY KEY,
      business_id    INT  NOT NULL,
      agrupacion_id  INT  NOT NULL REFERENCES agrupaciones(id) ON DELETE CASCADE,
      scope          TEXT NOT NULL CHECK (scope IN ('categoria','subrubro','articulo')),
      ref_id         TEXT NOT NULL
    );
  `);
  // dropear constraint vieja y su índice si existieran
  await execSafe(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agrupacion_exclusiones_unique_key') THEN
        ALTER TABLE agrupacion_exclusiones DROP CONSTRAINT agrupacion_exclusiones_unique_key;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'agrupacion_exclusiones_unique_key') THEN
        DROP INDEX agrupacion_exclusiones_unique_key;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'agrupacion_exclusiones_agr_idx') THEN
        DROP INDEX agrupacion_exclusiones_agr_idx;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'agrupacion_exclusiones_scope_idx') THEN
        DROP INDEX agrupacion_exclusiones_scope_idx;
      END IF;
    END$$;
  `);
  await execSafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_agrup_excl_unique
      ON agrupacion_exclusiones (business_id, agrupacion_id, scope, ref_id);
  `);
  await execSafe(`
    CREATE INDEX IF NOT EXISTS ix_agrup_excl_biz_group
      ON agrupacion_exclusiones (business_id, agrupacion_id);
  `);

  // =====================================================================
  // 6) Default group en negocios
  // =====================================================================
  await execSafe(`
    ALTER TABLE app_businesses
      ADD COLUMN IF NOT EXISTS default_group_id INT NULL;
  `);
  await execSafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name='app_businesses' AND constraint_name='fk_business_default_group'
      ) THEN
        ALTER TABLE app_businesses
        ADD CONSTRAINT fk_business_default_group
        FOREIGN KEY (default_group_id) REFERENCES agrupaciones(id) ON DELETE SET NULL;
      END IF;
    END$$;
  `);

  // =====================================================================
  // 7) Cache de menú de Maxi (usada por syncController)
  // =====================================================================
await execSafe(`
  CREATE TABLE IF NOT EXISTS public.maxi_menu_cache (
    business_id  integer NOT NULL REFERENCES public.app_businesses(id) ON DELETE CASCADE,
    payload      jsonb   NOT NULL,
    hash         text    NOT NULL,
    updated_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (business_id, hash)
  );
`);

// 👇 si la tabla ya existía sin la columna, la agrega
await execSafe(`ALTER TABLE public.maxi_menu_cache
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();`);

  // índice por negocio + “última actualización”
await execSafe(`
  CREATE INDEX IF NOT EXISTS maxi_menu_cache_biz_updated_idx
    ON public.maxi_menu_cache (business_id, updated_at DESC);
`);
  // =====================================================================
  // 8) Triggers updated_at genéricos
  // =====================================================================
  await execSafe(`
    CREATE OR REPLACE FUNCTION set_updated_at()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
  await execSafe(`DROP TRIGGER IF EXISTS trg_insumos_updated_at ON insumos;`);
  await execSafe(`CREATE TRIGGER trg_insumos_updated_at BEFORE UPDATE ON insumos FOR EACH ROW EXECUTE FUNCTION set_updated_at();`);
  await execSafe(`DROP TRIGGER IF EXISTS trg_pres_updated_at ON insumo_presentaciones;`);
  await execSafe(`CREATE TRIGGER trg_pres_updated_at BEFORE UPDATE ON insumo_presentaciones FOR EACH ROW EXECUTE FUNCTION set_updated_at();`);
  await execSafe(`DROP TRIGGER IF EXISTS trg_igrupos_updated_at ON insumo_grupos;`);
  await execSafe(`CREATE TRIGGER trg_igrupos_updated_at BEFORE UPDATE ON insumo_grupos FOR EACH ROW EXECUTE FUNCTION set_updated_at();`);
  await execSafe(`DROP TRIGGER IF EXISTS trg_agrupaciones_updated_at ON agrupaciones;`);
  await execSafe(`CREATE TRIGGER trg_agrupaciones_updated_at BEFORE UPDATE ON agrupaciones FOR EACH ROW EXECUTE FUNCTION set_updated_at();`);

  // =====================================================================
  // 9) Ejecutar archivos .sql (006_maxi_cache.sql fue removido; mantené 007_maxi_schema.sql, 008_maxi_sales_unique.sql, 014_sales.sql, 015_sales_indexes.sql, patchs que necesites)
  // =====================================================================
  const dir = path.join(__dirname, 'migrations');
  const sqlFiles = fs.readdirSync(dir)
    .filter(f => f.endsWith('.sql'))
    .sort(); // respeta el prefijo 007_, 008_, 014_, etc.

  for (const f of sqlFiles) {
    const full = path.join(dir, f);
    const sql = fs.readFileSync(full, 'utf8');
    try {
      console.log('➡️ Ejecutando', f, '...');
      await pool.query(sql);
      console.log('✅', f, 'OK');
    } catch (e) {
      if (['42710','42701','23505','42P07','23503'].includes(e.code)) {
        console.log('⚠️', f, 'omitido por idempotencia:', e.code);
      } else {
        throw e;
      }
    }
  }
}

module.exports = { runMigrations };
