// db/migrations.js
const pool = require('../config/db');

async function runMigrations() {
  const sql = `
  -- ===== Extensiones útiles (seguras) =====
  -- ===== Extensiones útiles (seguras) =====
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ===== INSUMOS (mínimo flexible) =====
CREATE TABLE IF NOT EXISTS insumos (
  id                BIGSERIAL PRIMARY KEY,
  codigo_maxi       TEXT UNIQUE,
  nombre            TEXT NOT NULL DEFAULT '',
  unidad_med        TEXT,
  precio_ref        NUMERIC(14,2),
  -- rubro queda deprecado
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

-- Asegura columnas si la tabla ya existía
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

-- 👍 NUEVO: columna generada con el código visible
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

-- Índices de búsqueda
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

  -- 👇 útil para buscar por código visible
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE tablename = 'insumos' AND indexname = 'insumos_codigo_mostrar_trgm'
  ) THEN
    CREATE INDEX insumos_codigo_mostrar_trgm ON insumos USING gin (codigo_mostrar gin_trgm_ops);
  END IF;
END$$;

-- ===== PRESENTACIONES por insumo =====
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

-- (Opcional) CHEKs simples para evitar typos en unidades
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pres_unidad_check'
  ) THEN
    ALTER TABLE insumo_presentaciones
    ADD CONSTRAINT pres_unidad_check
    CHECK (unidad IN ('kg','g','lt','ml','un'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pres_unidad_base_check'
  ) THEN
    ALTER TABLE insumo_presentaciones
    ADD CONSTRAINT pres_unidad_base_check
    CHECK (unidad_base IN ('kg','g','lt','ml','un'));
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'insumo_presentaciones_unique_key'
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

-- ===== AGRUPACIONES DE INSUMOS =====
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

-- (Nuevo) Único por cliente + nombre para evitar duplicados
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'insumo_grupos_cliente_nombre_key'
  ) THEN
    ALTER TABLE insumo_grupos
    ADD CONSTRAINT insumo_grupos_cliente_nombre_key
    UNIQUE (cliente_id, nombre);
  END IF;

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

-- ===== Triggers de updated_at (insumos, presentaciones, grupos, items) =====
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'set_updated_at') THEN
    CREATE OR REPLACE FUNCTION set_updated_at()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  END IF;
END$$;

DO $$
BEGIN
  -- insumos
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_insumos_updated_at') THEN
    CREATE TRIGGER trg_insumos_updated_at
    BEFORE UPDATE ON insumos
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;

  -- insumo_presentaciones
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_pres_updated_at') THEN
    CREATE TRIGGER trg_pres_updated_at
    BEFORE UPDATE ON insumo_presentaciones
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;

  -- insumo_grupos
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_igrupos_updated_at') THEN
    CREATE TRIGGER trg_igrupos_updated_at
    BEFORE UPDATE ON insumo_grupos
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;

  -- insumo_grupo_items (no tiene updated_at, así que omitimos)
END$$;
  `;

  await pool.query(sql);
}

module.exports = { runMigrations };
