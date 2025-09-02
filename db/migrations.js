// db/migrations.js
const pool = require('../config/db');
const m004 = require('./004_auth');
const m005 = require('./005_business_branding');
const m006 = require('./006_branches');
const fs = require('fs');
const path = require('path');

async function runMigrations() {
  const exec = (sql, params = []) => pool.query(sql, params);
  const execSafe = async (sql) => {
    try { await exec(sql); }
    catch (e) {
      if (['42710', '42701', '23505', '42P07'].includes(e.code)) return;
      throw e;
    }
  };

  console.log('📂 Usando base de datos PG:', process.env.PGDATABASE || '(desconocido)');

  // 0) extensiones
  await execSafe(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);

  // 1) AUTH — **UNA sola vez**
  await m004.up(pool);
  await m005.up(pool);   // 🔹 sucursales
  await m006.up(pool);
  // ========== 1) INSUMOS ==========
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

  await execSafe(`ALTER TABLE insumos ADD COLUMN codigo_maxi TEXT;`);
  await execSafe(`ALTER TABLE insumos ADD COLUMN nombre TEXT NOT NULL DEFAULT '';`);
  await execSafe(`ALTER TABLE insumos ADD COLUMN unidad_med TEXT;`);
  await execSafe(`ALTER TABLE insumos ADD COLUMN precio_ref NUMERIC(14,2);`);
  await execSafe(`ALTER TABLE insumos ADD COLUMN rubro TEXT;`);
  await execSafe(`ALTER TABLE insumos ADD COLUMN origen TEXT DEFAULT 'manual';`);
  await execSafe(`ALTER TABLE insumos ADD COLUMN activo BOOLEAN NOT NULL DEFAULT TRUE;`);
  await execSafe(`ALTER TABLE insumos ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();`);
  await execSafe(`ALTER TABLE insumos ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();`);

  await execSafe(`
    ALTER TABLE insumos
    ADD COLUMN codigo_mostrar TEXT
    GENERATED ALWAYS AS (
      COALESCE(NULLIF(BTRIM(codigo_maxi), ''), 'INS-' || id)
    ) STORED;
  `);

  await execSafe(`CREATE UNIQUE INDEX IF NOT EXISTS insumos_codigo_maxi_key ON insumos (codigo_maxi);`);
  await execSafe(`CREATE INDEX IF NOT EXISTS insumos_nombre_trgm ON insumos USING gin (nombre gin_trgm_ops);`);
  await execSafe(`CREATE INDEX IF NOT EXISTS insumos_activo_idx ON insumos (activo);`);
  await execSafe(`CREATE INDEX IF NOT EXISTS insumos_codigo_mostrar_trgm ON insumos USING gin (codigo_mostrar gin_trgm_ops);`);

  // ========== 2) Presentaciones por insumo ==========
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
    ALTER TABLE insumo_presentaciones
    ADD CONSTRAINT pres_unidad_check
    CHECK (unidad IN ('kg','g','lt','ml','un'));
  `);
  await execSafe(`
    ALTER TABLE insumo_presentaciones
    ADD CONSTRAINT pres_unidad_base_check
    CHECK (unidad_base IN ('kg','g','lt','ml','un'));
  `);

  await execSafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS insumo_presentaciones_unique_idx
    ON insumo_presentaciones (insumo_id, unidad, cantidad);
  `);
  await execSafe(`CREATE INDEX IF NOT EXISTS pres_insumo_idx ON insumo_presentaciones (insumo_id);`);
  await execSafe(`CREATE INDEX IF NOT EXISTS pres_unidad_idx ON insumo_presentaciones (unidad, activo);`);

  // ========== 3) Grupos de insumos ==========
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
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'insumo_grupos_cliente_nombre_key'
      ) THEN
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
  await execSafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS insumo_grupo_items_unique_idx
    ON insumo_grupo_items (grupo_id, insumo_id);
  `);
  await execSafe(`CREATE INDEX IF NOT EXISTS igi_grupo_idx ON insumo_grupo_items (grupo_id, orden);`);
  await execSafe(`CREATE INDEX IF NOT EXISTS igi_cliente_idx ON insumo_grupo_items (cliente_id);`);

  // ========== 4) AGRUPACIONES ==========
  await execSafe(`
    CREATE TABLE IF NOT EXISTS agrupaciones (
      id          SERIAL PRIMARY KEY,
      nombre      TEXT NOT NULL,
      articulos   JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await execSafe(`ALTER TABLE agrupaciones ADD COLUMN IF NOT EXISTS articulos JSONB;`);
  await execSafe(`ALTER TABLE agrupaciones ALTER COLUMN articulos SET DEFAULT '[]'::jsonb;`);
  await execSafe(`UPDATE agrupaciones SET articulos = '[]'::jsonb WHERE articulos IS NULL;`);
  await execSafe(`ALTER TABLE agrupaciones ALTER COLUMN articulos SET NOT NULL;`);

  await execSafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'agrupaciones_nombre_key'
      ) THEN
        CREATE UNIQUE INDEX IF NOT EXISTS agrupaciones_nombre_key
          ON agrupaciones (nombre);
        ALTER TABLE agrupaciones
          ADD CONSTRAINT agrupaciones_nombre_key
          UNIQUE USING INDEX agrupaciones_nombre_key;
      END IF;
    END$$;
  `);

  await execSafe(`CREATE INDEX IF NOT EXISTS agrupaciones_nombre_trgm ON agrupaciones USING gin (nombre gin_trgm_ops);`);
  await execSafe(`CREATE INDEX IF NOT EXISTS agrupaciones_articulos_gin ON agrupaciones USING gin (articulos);`);

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
  await execSafe(`ALTER TABLE agrupaciones ALTER COLUMN articulos SET NOT NULL;`);

  // 🔧 Hotfix explícito por si alguna instancia quedó desalineada
  await execSafe(`
  ALTER TABLE agrupaciones
    ALTER COLUMN articulos TYPE jsonb
    USING (CASE
      WHEN articulos IS NULL OR btrim(articulos::text) = '' THEN '[]'::jsonb
      ELSE articulos::jsonb
    END)
`);
  await execSafe(`ALTER TABLE agrupaciones ALTER COLUMN articulos SET DEFAULT '[]'::jsonb;`);
  await execSafe(`CREATE UNIQUE INDEX IF NOT EXISTS uq_agrupaciones_nombre ON agrupaciones (nombre);`);


  // ========== 5) EXCLUSIONES POR AGRUPACIÓN ==========
  await execSafe(`
    CREATE TABLE IF NOT EXISTS agrupacion_exclusiones (
      id             SERIAL PRIMARY KEY,
      agrupacion_id  INT  NOT NULL REFERENCES agrupaciones(id) ON DELETE CASCADE,
      scope          TEXT NOT NULL,
      ref_id         TEXT NOT NULL
    );
  `);

  await execSafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'agrupacion_exclusiones_scope_check'
      ) THEN
        ALTER TABLE agrupacion_exclusiones
        ADD CONSTRAINT agrupacion_exclusiones_scope_check
        CHECK (scope IN ('categoria','subrubro','articulo'));
      END IF;
    END$$;
  `);

  await execSafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'agrupacion_exclusiones_unique_key'
      ) THEN
        CREATE UNIQUE INDEX IF NOT EXISTS agrupacion_exclusiones_unique_key
          ON agrupacion_exclusiones (agrupacion_id, scope, ref_id);
        ALTER TABLE agrupacion_exclusiones
          ADD CONSTRAINT agrupacion_exclusiones_unique_key
          UNIQUE USING INDEX agrupacion_exclusiones_unique_key;
      END IF;
    END$$;
  `);

  await execSafe(`CREATE INDEX IF NOT EXISTS agrupacion_exclusiones_agr_idx ON agrupacion_exclusiones (agrupacion_id);`);
  await execSafe(`CREATE INDEX IF NOT EXISTS agrupacion_exclusiones_scope_idx ON agrupacion_exclusiones (scope);`);

  // ========== 6) Triggers de updated_at ==========
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
  await execSafe(`
    CREATE TRIGGER trg_insumos_updated_at
    BEFORE UPDATE ON insumos
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `);

  await execSafe(`DROP TRIGGER IF EXISTS trg_pres_updated_at ON insumo_presentaciones;`);
  await execSafe(`
    CREATE TRIGGER trg_pres_updated_at
    BEFORE UPDATE ON insumo_presentaciones
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `);

  await execSafe(`DROP TRIGGER IF EXISTS trg_igrupos_updated_at ON insumo_grupos;`);
  await execSafe(`
    CREATE TRIGGER trg_igrupos_updated_at
    BEFORE UPDATE ON insumo_grupos
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `);

  await execSafe(`DROP TRIGGER IF EXISTS trg_agrupaciones_updated_at ON agrupaciones;`);
  await execSafe(`
    CREATE TRIGGER trg_agrupaciones_updated_at
    BEFORE UPDATE ON agrupaciones
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `);

  // ========== 7) AUTH / MULTITENANT ==========
  if (m004?.up) {
    console.log('➡️ Ejecutando 004_auth...');
    await m004.up(pool);
    console.log('✅ 004_auth OK');
  }

}

module.exports = { runMigrations };
