// db/migrations.js
const pool = require('../config/db');

async function runMigrations() {
  const sql = `
  -- ===== Extensiones útiles (seguras) =====
  CREATE EXTENSION IF NOT EXISTS pg_trgm;

  -- ===== INSUMOS (mínimo flexible) =====
  CREATE TABLE IF NOT EXISTS insumos (
    id                BIGSERIAL PRIMARY KEY,
    codigo_maxi       TEXT UNIQUE,
    nombre            TEXT NOT NULL DEFAULT '',
    unidad_med        TEXT,
    precio_ref        NUMERIC(14,2),
    -- rubro queda deprecado (no lo usaremos, pero lo mantenemos por compatibilidad)
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

  -- Asegura columnas (por si la tabla ya existía con menos campos)
  ALTER TABLE insumos
    ADD COLUMN IF NOT EXISTS codigo_maxi TEXT,
    ADD COLUMN IF NOT EXISTS nombre TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS unidad_med TEXT,
    ADD COLUMN IF NOT EXISTS precio_ref NUMERIC(14,2),
    ADD COLUMN IF NOT EXISTS rubro TEXT,
    ADD COLUMN IF NOT EXISTS origen TEXT DEFAULT 'manual',
    ADD COLUMN IF NOT EXISTS activo BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

  DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_indexes WHERE tablename = 'insumos' AND indexname = 'insumos_codigo_maxi_key'
    ) THEN
      CREATE UNIQUE INDEX insumos_codigo_maxi_key ON insumos (codigo_maxi);
    END IF;
  END$$;

  -- Índices de búsqueda (opcionales pero útiles)
  DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_indexes WHERE tablename = 'insumos' AND indexname = 'insumos_nombre_trgm'
    ) THEN
      CREATE INDEX insumos_nombre_trgm ON insumos USING gin (nombre gin_trgm_ops);
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_indexes WHERE tablename = 'insumos' AND indexname = 'insumos_activo_idx'
    ) THEN
      CREATE INDEX insumos_activo_idx ON insumos (activo);
    END IF;
  END$$;

  -- ===== PRESENTACIONES por insumo =====
  CREATE TABLE IF NOT EXISTS insumo_presentaciones (
    id              BIGSERIAL PRIMARY KEY,
    insumo_id       BIGINT NOT NULL REFERENCES insumos(id) ON DELETE CASCADE,
    unidad          TEXT   NOT NULL,              -- ej: kg, g, lt, ml, unidad
    cantidad        NUMERIC(14,4) NOT NULL,       -- ej: 1, 500, etc.
    precio          NUMERIC(14,2) NOT NULL,       -- precio del paquete
    unidad_base     TEXT   NOT NULL,              -- ej: g, ml, unidad
    factor_base     NUMERIC(14,6) NOT NULL,       -- ej: 1000 si unidad=kg y base=g
    precio_unitario NUMERIC(14,6) GENERATED ALWAYS AS
      (CASE WHEN (cantidad * factor_base) > 0
            THEN precio / (cantidad * factor_base)
            ELSE NULL END) STORED,
    activo          BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'insumo_presentaciones_unique_key'
    ) THEN
      ALTER TABLE insumo_presentaciones
      ADD CONSTRAINT insumo_presentaciones_unique_key
      UNIQUE (insumo_id, unidad, cantidad);
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_indexes WHERE tablename = 'insumo_presentaciones' AND indexname = 'pres_insumo_idx'
    ) THEN
      CREATE INDEX pres_insumo_idx ON insumo_presentaciones (insumo_id);
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_indexes WHERE tablename = 'insumo_presentaciones' AND indexname = 'pres_unidad_idx'
    ) THEN
      CREATE INDEX pres_unidad_idx ON insumo_presentaciones (unidad, activo);
    END IF;
  END$$;

  -- ===== AGRUPACIONES (sin “rubro” fijo) =====
  CREATE TABLE IF NOT EXISTS insumo_grupos (
    id           BIGSERIAL PRIMARY KEY,
    cliente_id   BIGINT,                 -- null = global; o tu id de cliente/tenant
    nombre       TEXT NOT NULL,
    descripcion  TEXT,
    parent_id    BIGINT REFERENCES insumo_grupos(id) ON DELETE SET NULL,
    orden        INT NOT NULL DEFAULT 0,
    activo       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS insumo_grupo_items (
    id           BIGSERIAL PRIMARY KEY,
    grupo_id     BIGINT NOT NULL REFERENCES insumo_grupos(id) ON DELETE CASCADE,
    insumo_id    BIGINT NOT NULL REFERENCES insumos(id) ON DELETE CASCADE,
    cliente_id   BIGINT,
    orden        INT NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (grupo_id, insumo_id)
  );

  DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_indexes WHERE tablename = 'insumo_grupos' AND indexname = 'ig_cliente_idx'
    ) THEN
      CREATE INDEX ig_cliente_idx ON insumo_grupos (cliente_id, activo);
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_indexes WHERE tablename = 'insumo_grupos' AND indexname = 'ig_parent_idx'
    ) THEN
      CREATE INDEX ig_parent_idx ON insumo_grupos (parent_id);
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_indexes WHERE tablename = 'insumo_grupo_items' AND indexname = 'igi_grupo_idx'
    ) THEN
      CREATE INDEX igi_grupo_idx ON insumo_grupo_items (grupo_id, orden);
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_indexes WHERE tablename = 'insumo_grupo_items' AND indexname = 'igi_cliente_idx'
    ) THEN
      CREATE INDEX igi_cliente_idx ON insumo_grupo_items (cliente_id);
    END IF;
  END$$;
  `;

  await pool.query(sql);
}

module.exports = { runMigrations };
