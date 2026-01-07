-- 019_csv_mappings.sql

CREATE TABLE IF NOT EXISTS sales_csv_mappings (
  id               SERIAL PRIMARY KEY,
  business_id      INTEGER NOT NULL REFERENCES app_businesses(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  description      TEXT,
  column_mapping   JSONB NOT NULL,
  required_columns TEXT[],
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (business_id, name)
);

-- Asegurar columna is_active (para esquemas previos)
ALTER TABLE sales_csv_mappings
ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;

-- Índice (ahora sí seguro)
CREATE INDEX IF NOT EXISTS idx_csv_mappings_business 
  ON sales_csv_mappings(business_id, is_active);
