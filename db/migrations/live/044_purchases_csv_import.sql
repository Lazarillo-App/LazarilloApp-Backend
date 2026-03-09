-- 044_purchases_csv_import.sql
-- Tabla de registro de importaciones CSV de compras
-- + columna source en purchases y purchase_items para distinguir CSV vs MaxiRest

-- ===================== SOURCE EN PURCHASES =====================
ALTER TABLE purchases
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'maxi';

-- ===================== SOURCE EN PURCHASE_ITEMS =====================
ALTER TABLE purchase_items
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'maxi';

-- Índice para filtrar por source + fecha (lo usamos en el DELETE del rango)
CREATE INDEX IF NOT EXISTS idx_purchase_items_source_fecha
  ON purchase_items (business_id, source, fecha);

CREATE INDEX IF NOT EXISTS idx_purchases_source_fecha
  ON purchases (business_id, source, fecha);

-- ===================== TABLA DE IMPORTACIONES =====================
CREATE TABLE IF NOT EXISTS purchases_csv_imports (
  id            BIGSERIAL     PRIMARY KEY,
  business_id   BIGINT        NOT NULL,
  user_id       BIGINT,
  filename      TEXT,
  original_name TEXT,
  file_size     BIGINT,
  file_type     TEXT,
  status        TEXT          NOT NULL DEFAULT 'processing',
  -- processing | completed | failed
  row_count     INT,
  date_from     DATE,
  date_to       DATE,
  rows_inserted INT,
  rows_failed   INT,
  error_log     JSONB,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  processed_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_purchases_csv_imports_biz
  ON purchases_csv_imports (business_id, created_at DESC);