-- 019_sales_items_add_cols.sql

-- Asegurar columnas en app_sales_items
ALTER TABLE app_sales_items
  ADD COLUMN IF NOT EXISTS line_pos   int;

ALTER TABLE app_sales_items
  ADD COLUMN IF NOT EXISTS article_id int;

ALTER TABLE app_sales_items
  ADD COLUMN IF NOT EXISTS article_name text;

ALTER TABLE app_sales_items
  ADD COLUMN IF NOT EXISTS qty numeric(14,3) DEFAULT 0 NOT NULL;

ALTER TABLE app_sales_items
  ADD COLUMN IF NOT EXISTS amount numeric(14,2) DEFAULT 0 NOT NULL;

-- Unicidad por línea dentro de la venta
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'ux_app_sales_items_sale_line'
  ) THEN
    CREATE UNIQUE INDEX ux_app_sales_items_sale_line
      ON app_sales_items (sale_id, line_pos);
  END IF;
END $$;

-- Asegurar claves foráneas mínimas (si no existen)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'fk_app_sales_items_sale'
      AND table_name = 'app_sales_items'
  ) THEN
    ALTER TABLE app_sales_items
      ADD CONSTRAINT fk_app_sales_items_sale
      FOREIGN KEY (sale_id) REFERENCES app_sales(id) ON DELETE CASCADE;
  END IF;
END $$;

-- Agregados diarios (por si faltaran)
CREATE TABLE IF NOT EXISTS sales_daily (
  business_id int NOT NULL,
  day date NOT NULL,
  total numeric(14,2) NOT NULL DEFAULT 0,
  tx_count int NOT NULL DEFAULT 0,
  PRIMARY KEY (business_id, day)
);

CREATE TABLE IF NOT EXISTS sales_daily_items (
  business_id int NOT NULL,
  day date NOT NULL,
  article_id int,
  qty numeric(14,3) NOT NULL DEFAULT 0,
  amount numeric(14,2) NOT NULL DEFAULT 0,
  PRIMARY KEY (business_id, day, article_id)
);
