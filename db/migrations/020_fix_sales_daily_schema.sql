-- 020_fix_sales_daily_schema.sql
-- Normaliza sales_daily y sales_daily_items para que tengan "day" (DATE) y claves esperadas

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

-- Asegurar columnas
ALTER TABLE sales_daily
  ADD COLUMN IF NOT EXISTS business_id int,
  ADD COLUMN IF NOT EXISTS day         date,
  ADD COLUMN IF NOT EXISTS total       numeric(14,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tx_count    int DEFAULT 0;

-- Intento de migrar datos si existen columnas antiguas
DO $$
BEGIN
  -- Si hay una columna 'fecha' o 'occurred_at', volcamos a 'day' cuando esté NULL
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='sales_daily' AND column_name='fecha'
  ) THEN
    UPDATE sales_daily
       SET day = COALESCE(day, fecha::date)
     WHERE day IS NULL;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='sales_daily' AND column_name='occurred_at'
  ) THEN
    UPDATE sales_daily
       SET day = COALESCE(day, occurred_at::date)
     WHERE day IS NULL;
  END IF;
END $$;

-- Marcar NOT NULL donde corresponda
ALTER TABLE sales_daily
  ALTER COLUMN business_id SET NOT NULL;

-- Si aún hay NULLs en day, llénalos con una fecha dummy para poder poner NOT NULL (luego se recalcula)
UPDATE sales_daily SET day = DATE '1970-01-01' WHERE day IS NULL;
ALTER TABLE sales_daily
  ALTER COLUMN day SET NOT NULL;

-- Primary key consistente (business_id, day)
DO $$
DECLARE
  pk_name text;
BEGIN
  SELECT tc.constraint_name INTO pk_name
  FROM information_schema.table_constraints tc
  WHERE tc.table_name='sales_daily' AND tc.constraint_type='PRIMARY KEY';

  IF pk_name IS NULL OR pk_name <> 'sales_daily_pkey' THEN
    -- Si existe otra PK diferente, la eliminamos
    IF pk_name IS NOT NULL THEN
      EXECUTE format('ALTER TABLE sales_daily DROP CONSTRAINT %I', pk_name);
    END IF;
    ALTER TABLE sales_daily
      ADD CONSTRAINT sales_daily_pkey PRIMARY KEY (business_id, day);
  END IF;
END $$;

-- Índice auxiliar opcional
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

-- Asegurar columnas
ALTER TABLE sales_daily_items
  ADD COLUMN IF NOT EXISTS business_id int,
  ADD COLUMN IF NOT EXISTS day         date,
  ADD COLUMN IF NOT EXISTS article_id  int,
  ADD COLUMN IF NOT EXISTS qty         numeric(14,3) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS amount      numeric(14,2) DEFAULT 0;

-- Migrar day si existiese una columna antigua
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='sales_daily_items' AND column_name='fecha'
  ) THEN
    UPDATE sales_daily_items
       SET day = COALESCE(day, fecha::date)
     WHERE day IS NULL;
  END IF;
END $$;

ALTER TABLE sales_daily_items
  ALTER COLUMN business_id SET NOT NULL;

UPDATE sales_daily_items SET day = DATE '1970-01-01' WHERE day IS NULL;
ALTER TABLE sales_daily_items
  ALTER COLUMN day SET NOT NULL;

-- Primary key correcta
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
