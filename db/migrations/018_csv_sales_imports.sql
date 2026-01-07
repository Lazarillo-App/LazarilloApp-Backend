-- migrations/018_csv_sales_imports.sql

-- ============================================================================
-- TABLA: sales_csv_imports
-- Registro de archivos CSV/XLS importados manualmente
-- ============================================================================

CREATE TABLE IF NOT EXISTS sales_csv_imports (
  id              BIGSERIAL PRIMARY KEY,
  business_id     INTEGER NOT NULL REFERENCES app_businesses(id) ON DELETE CASCADE,
  user_id         INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  
  -- Información del archivo
  filename        TEXT NOT NULL,
  original_name   TEXT NOT NULL,
  file_size       BIGINT NOT NULL,
  file_type       TEXT NOT NULL,
  
  -- Estado del proceso
  status          TEXT NOT NULL DEFAULT 'pending',
  
  -- Metadata del contenido
  row_count       INTEGER,
  date_from       DATE,
  date_to         DATE,
  
  -- Resultados de la importación
  rows_inserted   INTEGER DEFAULT 0,
  rows_updated    INTEGER DEFAULT 0,
  rows_failed     INTEGER DEFAULT 0,
  
  -- Log de errores
  error_log       JSONB,
  
  -- Timestamps
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  processed_at    TIMESTAMPTZ,
  
  -- Constraints
  CONSTRAINT sales_csv_imports_status_check 
    CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  
  CONSTRAINT sales_csv_imports_file_type_check
    CHECK (file_type IN ('csv', 'xls', 'xlsx'))
);

-- Índices (solo si no existen)
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes 
    WHERE indexname = 'idx_csv_imports_business_date'
  ) THEN
    CREATE INDEX idx_csv_imports_business_date 
      ON sales_csv_imports(business_id, created_at DESC);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes 
    WHERE indexname = 'idx_csv_imports_status'
  ) THEN
    CREATE INDEX idx_csv_imports_status 
      ON sales_csv_imports(status, created_at DESC);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes 
    WHERE indexname = 'idx_csv_imports_user'
  ) THEN
    CREATE INDEX idx_csv_imports_user 
      ON sales_csv_imports(user_id, created_at DESC);
  END IF;
END $$;

-- Comentarios
COMMENT ON TABLE sales_csv_imports IS 
  'Registro de importaciones manuales de ventas vía CSV/XLS/XLSX';

COMMENT ON COLUMN sales_csv_imports.status IS 
  'Estado: pending, processing, completed, failed';

-- ============================================================================
-- TABLA: sales_csv_mappings (OPCIONAL - Para futuro)
-- ============================================================================

CREATE TABLE IF NOT EXISTS sales_csv_mappings (
  id              SERIAL PRIMARY KEY,
  business_id     INTEGER NOT NULL REFERENCES app_businesses(id) ON DELETE CASCADE,
  
  name            TEXT NOT NULL,
  description     TEXT,
  column_mapping  JSONB NOT NULL,
  required_columns TEXT[],
  is_active       BOOLEAN DEFAULT true,
  
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  
  UNIQUE(business_id, name)
);

-- Índice para mappings (solo si no existe)
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes 
    WHERE indexname = 'idx_csv_mappings_business'
  ) THEN
    CREATE INDEX idx_csv_mappings_business 
      ON sales_csv_mappings(business_id, is_active);
  END IF;
END $$;

COMMENT ON TABLE sales_csv_mappings IS 
  'Configuraciones de mapeo de columnas CSV (feature futuro)';

-- ============================================================================
-- Agregar columna article_name a sales_daily_items (OPCIONAL)
-- ============================================================================

DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'sales_daily_items' 
    AND column_name = 'article_name'
  ) THEN
    ALTER TABLE sales_daily_items 
    ADD COLUMN article_name TEXT;
    
    COMMENT ON COLUMN sales_daily_items.article_name IS 
      'Nombre del artículo al momento de la importación (para referencia)';
  END IF;
END $$;