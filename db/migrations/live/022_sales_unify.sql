-- 022_sales_unify.sql  ← única migración “verdad” para ventas/agregados
BEGIN;

-- ========== app_sales_items: columnas que usa el pipeline ==========
ALTER TABLE app_sales_items
  ADD COLUMN IF NOT EXISTS line_pos   int,
  ADD COLUMN IF NOT EXISTS article_id int,
  ADD COLUMN IF NOT EXISTS title      text,
  ADD COLUMN IF NOT EXISTS qty        numeric(14,3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS amount     numeric(14,2) NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='ux_app_sales_items_sale_line') THEN
    CREATE UNIQUE INDEX ux_app_sales_items_sale_line ON app_sales_items (sale_id, line_pos);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name='app_sales_items' AND constraint_name='fk_app_sales_items_sale'
  ) THEN
    ALTER TABLE app_sales_items
      ADD CONSTRAINT fk_app_sales_items_sale
      FOREIGN KEY (sale_id) REFERENCES app_sales(id) ON DELETE CASCADE;
  END IF;
END $$;

-- ========== sales_daily: PK (business_id, day) ==========
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='sales_daily') THEN
    CREATE TABLE sales_daily (
      business_id int NOT NULL,
      day         date NOT NULL,
      total       numeric(14,2) NOT NULL DEFAULT 0,
      tx_count    int NOT NULL DEFAULT 0,
      PRIMARY KEY (business_id, day)
    );
  END IF;
END $$;

ALTER TABLE sales_daily
  ADD COLUMN IF NOT EXISTS business_id int,
  ADD COLUMN IF NOT EXISTS day         date,
  ADD COLUMN IF NOT EXISTS total       numeric(14,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tx_count    int          DEFAULT 0;

ALTER TABLE sales_daily
  ALTER COLUMN business_id SET NOT NULL;

UPDATE sales_daily SET day = DATE '1970-01-01' WHERE day IS NULL;
ALTER TABLE sales_daily
  ALTER COLUMN day SET NOT NULL;

DO $$
DECLARE pk text;
BEGIN
  SELECT tc.constraint_name INTO pk
  FROM information_schema.table_constraints tc
  WHERE tc.table_name='sales_daily' AND tc.constraint_type='PRIMARY KEY';
  IF pk IS NULL OR pk <> 'sales_daily_pkey' THEN
    IF pk IS NOT NULL THEN
      EXECUTE format('ALTER TABLE sales_daily DROP CONSTRAINT %I', pk);
    END IF;
    ALTER TABLE sales_daily
      ADD CONSTRAINT sales_daily_pkey PRIMARY KEY (business_id, day);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='ix_sales_daily_day') THEN
    CREATE INDEX ix_sales_daily_day ON sales_daily(day);
  END IF;
END $$;

-- ========== sales_daily_items: PK (business_id, day, article_id) ==========
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='sales_daily_items') THEN
    CREATE TABLE sales_daily_items (
      business_id int NOT NULL,
      day         date NOT NULL,
      article_id  int  NOT NULL,
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

-- Migración desde columnas legacy si estuvieran
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='sales_daily_items' AND column_name='articulo_id') THEN
    EXECUTE 'UPDATE sales_daily_items SET article_id = COALESCE(article_id, articulo_id) WHERE article_id IS NULL';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='sales_daily_items' AND column_name='date') THEN
    EXECUTE 'UPDATE sales_daily_items SET day = COALESCE(day, "date") WHERE day IS NULL';
  END IF;
END $$;

-- Borra filas inválidas (no deberían existir en agregados)
DELETE FROM sales_daily_items WHERE article_id IS NULL OR day IS NULL;

-- Rehacer PK correcta
DO $$
DECLARE pk text;
BEGIN
  SELECT tc.constraint_name INTO pk
  FROM information_schema.table_constraints tc
  WHERE tc.table_name='sales_daily_items' AND tc.constraint_type='PRIMARY KEY';
  IF pk IS NOT NULL THEN
    EXECUTE format('ALTER TABLE sales_daily_items DROP CONSTRAINT %I', pk);
  END IF;

  ALTER TABLE sales_daily_items
    ALTER COLUMN business_id SET NOT NULL,
    ALTER COLUMN day         SET NOT NULL,
    ALTER COLUMN article_id  SET NOT NULL;

  ALTER TABLE sales_daily_items
    ADD CONSTRAINT sales_daily_items_pkey PRIMARY KEY (business_id, day, article_id);
END $$;

-- Índices
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='ix_sales_daily_items_day') THEN
    CREATE INDEX ix_sales_daily_items_day ON sales_daily_items(day);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='ix_sales_daily_items_article') THEN
    CREATE INDEX ix_sales_daily_items_article ON sales_daily_items(article_id);
  END IF;
END $$;

-- Limpieza de columnas legacy (si quedaran)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='sales_daily_items' AND column_name='articulo_id') THEN
    EXECUTE 'ALTER TABLE sales_daily_items DROP COLUMN articulo_id';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='sales_daily_items' AND column_name='date') THEN
    EXECUTE 'ALTER TABLE sales_daily_items DROP COLUMN "date"';
  END IF;
END $$;

COMMIT;
