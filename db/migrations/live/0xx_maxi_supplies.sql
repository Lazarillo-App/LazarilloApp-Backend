-- 0xx_maxi_supplies.sql
-- Tabla para insumos traídos desde Maxi (por negocio)

CREATE TABLE IF NOT EXISTS maxi_supplies (
  id           BIGSERIAL PRIMARY KEY,
  business_id  BIGINT NOT NULL REFERENCES app_businesses(id) ON DELETE CASCADE,

  codigo       INTEGER NOT NULL,          -- "codigo" de Maxi
  nombre       TEXT,                      -- "nombre"
  rubro        INTEGER,                   -- rubro (código numérico Maxi)
  medida       TEXT,                      -- "medida" (u, L, Kg, etc.)
  precio       NUMERIC(18,4),             -- "precio" Maxi
  iva          TEXT,                      -- puede venir vacío
  imp_int      NUMERIC(18,4),
  discontinuado BOOLEAN DEFAULT FALSE,    -- 0/1 de Maxi

  raw          JSONB,                     -- payload completo para debugging
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (business_id, codigo)
);

CREATE INDEX IF NOT EXISTS idx_maxi_supplies_business
  ON maxi_supplies (business_id);

CREATE INDEX IF NOT EXISTS idx_maxi_supplies_business_rubro
  ON maxi_supplies (business_id, rubro);
