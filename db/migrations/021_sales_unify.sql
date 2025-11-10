-- 021_sales_unify.sql
-- Unifica esquema de ventas: app_sales_items + sales_daily + sales_daily_items
-- Idempotente y seguro para correr varias veces.

BEGIN;

-- ========== app_sales_items ==========
-- Columnas mínimas que usa el normalizador actual (NO usamos article_name)
ALTER TABLE app_sales_items
  ADD COLUMN IF NOT EXISTS line_pos     int,
  ADD COLUMN IF NOT EXISTS article_id   int,
  ADD COLUMN IF NOT EXISTS title        text,
  ADD COLUMN IF NOT EXISTS qty          numeric(14,3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS amount       numeric(14,2) NOT NULL DEFAULT 0;

-- Index de unicidad por línea dentro de la venta
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'ux_app_sales_items_sale_line'
  ) THEN
    CREATE UNIQUE INDEX ux_app_sales_items_sale_line
      ON app_sales_items (sale_id, line_pos);
  END IF;
END $$;

-- FK básica a app_sales
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

-- ========== sales_daily ==========
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'sales_daily'
  ) THEN
    CREATE TABLE sales_daily (
      business_id int NOT NULL,
      day         date NOT NULL,
      total       numeric(14,2) NOT NULL DEFAULT 0,
      tx_count    int NOT NULL DEFAULT 0,
      PRIMARY KEY (business_id, day)
    );
  END IF;
END $$;

-- Asegurar columnas y NOT NULL
ALTER TABLE sales_daily
  ADD COLUMN IF NOT EXISTS business_id int,
  ADD COLUMN IF NOT EXISTS day         date,
  ADD COLUMN IF NOT EXISTS total       numeric(14,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tx_count    int DEFAULT 0;

ALTER TABLE sales_daily
  ALTER COLUMN business_id SET NOT NULL;

-- Si quedó day en NULL por esquemas viejos, rellenar con 1970-01-01 para poder not null (luego se recalcula)
UPDATE sales_daily SET day = DATE '1970-01-01' WHERE day IS NULL;

ALTER TABLE sales_daily
  ALTER COLUMN day SET NOT NULL;

-- PK consistente
DO $$
DECLARE
  pk_name text;
BEGIN
  SELECT tc.constraint_name INTO pk_name
  FROM information_schema.table_constraints tc
  WHERE tc.table_name='sales_daily' AND tc.constraint_type='PRIMARY KEY';

  IF pk_name IS NULL OR pk_name <> 'sales_daily_pkey' THEN
    IF pk_name IS NOT NULL THEN
      EXECUTE format('ALTER TABLE sales_daily DROP CONSTRAINT %I', pk_name);
    END IF;
    ALTER TABLE sales_daily
      ADD CONSTRAINT sales_daily_pkey PRIMARY KEY (business_id, day);
  END IF;
END $$;

-- Índice auxiliar
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname='ix_sales_daily_day'
  ) THEN
    CREATE INDEX ix_sales_daily_day ON sales_daily(day);
  END IF;
END $$;

-- ========== sales_daily_items ==========
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'sales_daily_items'
  ) THEN
    CREATE TABLE sales_daily_items (
      business_id int NOT NULL,
      day         date NOT NULL,
      article_id  int,
      qty         numeric(14,3) NOT NULL DEFAULT 0,
      amount      numeric(14,2) NOT NULL DEFAULT 0,
      PRIMARY KEY (business_id, day, article_id)
    );
  END IF;
END $$;

ALTER TABLE sales_daily_items
  ADD COLUMN IF NOT EXISTS business_id int,
  ADD COLUMN IF NOT EXISTS day         date,
  ADD COLUMN IF NOT EXISTS article_id  int,
  ADD COLUMN IF NOT EXISTS qty         numeric(14,3) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS amount      numeric(14,2) DEFAULT 0;

ALTER TABLE sales_daily_items
  ALTER COLUMN business_id SET NOT NULL;

UPDATE sales_daily_items SET day = DATE '1970-01-01' WHERE day IS NULL;
ALTER TABLE sales_daily_items
  ALTER COLUMN day SET NOT NULL;

-- PK correcta
DO $$
DECLARE
  pk_name text;
BEGIN
  SELECT tc.constraint_name INTO pk_name
  FROM information_schema.table_constraints tc
  WHERE tc.table_name='sales_daily_items' AND tc.constraint_type='PRIMARY KEY';

  IF pk_name IS NULL OR pk_name <> 'sales_daily_items_pkey' THEN
    IF pk_name IS NOT NULL THEN
      EXECUTE format('ALTER TABLE sales_daily_items DROP CONSTRAINT %I', pk_name);
    END IF;
    ALTER TABLE sales_daily_items
      ADD CONSTRAINT sales_daily_items_pkey PRIMARY KEY (business_id, day, article_id);
  END IF;
END $$;

-- Índices auxiliares
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname='ix_sales_daily_items_day'
  ) THEN
    CREATE INDEX ix_sales_daily_items_day ON sales_daily_items(day);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname='ix_sales_daily_items_article'
  ) THEN
    CREATE INDEX ix_sales_daily_items_article ON sales_daily_items(article_id);
  END IF;
END $$;

COMMIT;
