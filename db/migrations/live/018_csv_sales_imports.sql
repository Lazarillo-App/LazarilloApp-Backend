CREATE TABLE IF NOT EXISTS sales_csv_imports (
  id              BIGSERIAL PRIMARY KEY,
  business_id     INTEGER NOT NULL REFERENCES app_businesses(id) ON DELETE CASCADE,
  user_id         INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  filename        TEXT NOT NULL,
  original_name   TEXT NOT NULL,
  file_size       BIGINT NOT NULL,
  file_type       TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  row_count       INTEGER,
  date_from       DATE,
  date_to         DATE,
  rows_inserted   INTEGER DEFAULT 0,
  rows_updated    INTEGER DEFAULT 0,
  rows_failed     INTEGER DEFAULT 0,
  error_log       JSONB,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  processed_at    TIMESTAMPTZ,
  CONSTRAINT sales_csv_imports_status_check 
    CHECK (status IN ('pending','processing','completed','failed')),
  CONSTRAINT sales_csv_imports_file_type_check
    CHECK (file_type IN ('csv','xls','xlsx'))
);

CREATE INDEX IF NOT EXISTS idx_csv_imports_business_date 
  ON sales_csv_imports(business_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_csv_imports_status 
  ON sales_csv_imports(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_csv_imports_user 
  ON sales_csv_imports(user_id, created_at DESC);

COMMENT ON TABLE sales_csv_imports IS
  'Registro de importaciones manuales de ventas';
