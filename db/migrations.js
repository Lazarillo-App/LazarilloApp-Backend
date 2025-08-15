// db/migrations.js
const pool = require('../config/db');

async function runMigrations() {
  const exec = (sql, params = []) => pool.query(sql, params);

  // ejecuta y si es "objeto duplicado" (índice/columna/constraint ya existe), lo ignora
  const execSafe = async (sql) => {
    try {
      await exec(sql);
    } catch (e) {
      // 42710 duplicate_object, 42701 duplicate_column, 23505 unique_violation
      if (['42710', '42701', '23505'].includes(e.code)) return;
      throw e;
    }
  };

  // 1) Extensiones
  await exec(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);

  // 2) Tabla INSUMOS (creación base)
  await exec(`
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

  // 2.1) Asegurar columnas (si venías con una versión previa)
  await execSafe(`ALTER TABLE insumos ADD COLUMN codigo_maxi TEXT;`);
  await execSafe(`ALTER TABLE insumos ADD COLUMN nombre TEXT NOT NULL DEFAULT '';`);
  await execSafe(`ALTER TABLE insumos ADD COLUMN unidad_med TEXT;`);
  await execSafe(`ALTER TABLE insumos ADD COLUMN precio_ref NUMERIC(14,2);`);
  await execSafe(`ALTER TABLE insumos ADD COLUMN rubro TEXT;`);
  await execSafe(`ALTER TABLE insumos ADD COLUMN origen TEXT DEFAULT 'manual';`);
  await execSafe(`ALTER TABLE insumos ADD COLUMN activo BOOLEAN NOT NULL DEFAULT TRUE;`);
  await execSafe(`ALTER TABLE insumos ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();`);
  await execSafe(`ALTER TABLE insumos ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();`);

  // 2.2) Columna generada: codigo_mostrar (si ya existe, lo ignoro)
  await execSafe(`
    ALTER TABLE insumos
    ADD COLUMN codigo_mostrar TEXT
    GENERATED ALWAYS AS (
      COALESCE(NULLIF(BTRIM(codigo_maxi), ''), 'INS-' || id)
    ) STORED;
  `);

  // 2.3) Índices
  await exec(`CREATE UNIQUE INDEX IF NOT EXISTS insumos_codigo_maxi_key ON insumos (codigo_maxi);`);
  await exec(`CREATE INDEX IF NOT EXISTS insumos_nombre_trgm ON insumos USING gin (nombre gin_trgm_ops);`);
  await exec(`CREATE INDEX IF NOT EXISTS insumos_activo_idx ON insumos (activo);`);
  await exec(`CREATE INDEX IF NOT EXISTS insumos_codigo_mostrar_trgm ON insumos USING gin (codigo_mostrar gin_trgm_ops);`);

  // 3) Presentaciones por insumo
  await exec(`
    CREATE TABLE IF NOT EXISTS insumo_presentaciones (
      id              BIGSERIAL PRIMARY KEY,
      insumo_id       BIGINT NOT NULL REFERENCES insumos(id) ON DELETE CASCADE,
      unidad          TEXT   NOT NULL,              -- ej: kg, g, lt, ml, un
      cantidad        NUMERIC(14,4) NOT NULL,       -- ej: 1, 500, etc.
      precio          NUMERIC(14,2) NOT NULL,       -- precio del paquete
      unidad_base     TEXT   NOT NULL,              -- ej: g, ml, un
      factor_base     NUMERIC(14,6) NOT NULL,       -- ej: 1000 si unidad=kg y base=g
      precio_unitario NUMERIC(14,6) GENERATED ALWAYS AS
        (CASE WHEN (cantidad * factor_base) > 0
              THEN precio / (cantidad * factor_base)
              ELSE NULL END) STORED,
      activo          BOOLEAN NOT NULL DEFAULT TRUE,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // 3.1) CHECKs de unidades (si ya existen, los ignoro con execSafe)
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

  // 3.2) Únicos / índices presentaciones
  await exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS insumo_presentaciones_unique_idx
    ON insumo_presentaciones (insumo_id, unidad, cantidad);
  `);
  await exec(`CREATE INDEX IF NOT EXISTS pres_insumo_idx ON insumo_presentaciones (insumo_id);`);
  await exec(`CREATE INDEX IF NOT EXISTS pres_unidad_idx ON insumo_presentaciones (unidad, activo);`);

  // 4) Grupos de insumos
  await exec(`
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

  await exec(`
    CREATE TABLE IF NOT EXISTS insumo_grupo_items (
      id           BIGSERIAL PRIMARY KEY,
      grupo_id     BIGINT NOT NULL REFERENCES insumo_grupos(id) ON DELETE CASCADE,
      insumo_id    BIGINT NOT NULL REFERENCES insumos(id) ON DELETE CASCADE,
      cliente_id   BIGINT,
      orden        INT NOT NULL DEFAULT 0,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // 4.1) Único por cliente+nombre y otros índices
  await execSafe(`
    ALTER TABLE insumo_grupos
    ADD CONSTRAINT insumo_grupos_cliente_nombre_key
    UNIQUE (cliente_id, nombre);
  `);
  await exec(`CREATE INDEX IF NOT EXISTS ig_cliente_idx ON insumo_grupos (cliente_id, activo);`);
  await exec(`CREATE INDEX IF NOT EXISTS ig_parent_idx ON insumo_grupos (parent_id);`);
  await exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS insumo_grupo_items_unique_idx
    ON insumo_grupo_items (grupo_id, insumo_id);
  `);
  await exec(`CREATE INDEX IF NOT EXISTS igi_grupo_idx ON insumo_grupo_items (grupo_id, orden);`);
  await exec(`CREATE INDEX IF NOT EXISTS igi_cliente_idx ON insumo_grupo_items (cliente_id);`);

  // 5) Función y triggers de updated_at (idempotentes sin DO $$)
  await exec(`
    CREATE OR REPLACE FUNCTION set_updated_at()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);

  // Triggers: dropeo si existen y los creo de nuevo (idempotente)
  await exec(`DROP TRIGGER IF EXISTS trg_insumos_updated_at ON insumos;`);
  await exec(`
    CREATE TRIGGER trg_insumos_updated_at
    BEFORE UPDATE ON insumos
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `);

  await exec(`DROP TRIGGER IF EXISTS trg_pres_updated_at ON insumo_presentaciones;`);
  await exec(`
    CREATE TRIGGER trg_pres_updated_at
    BEFORE UPDATE ON insumo_presentaciones
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `);

  await exec(`DROP TRIGGER IF EXISTS trg_igrupos_updated_at ON insumo_grupos;`);
  await exec(`
    CREATE TRIGGER trg_igrupos_updated_at
    BEFORE UPDATE ON insumo_grupos
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `);
}

module.exports = { runMigrations };
