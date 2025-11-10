-- 017_sales_daily_items.sql  (reemplazo)
BEGIN;

-- Crea la tabla con el esquema nuevo si no existe
CREATE TABLE IF NOT EXISTS sales_daily_items (
  business_id BIGINT NOT NULL REFERENCES app_businesses(id) ON DELETE CASCADE,
  article_id  INT,
  day         DATE NOT NULL,
  qty         NUMERIC(14,3) NOT NULL DEFAULT 0,
  amount      NUMERIC(14,2) NOT NULL DEFAULT 0,
  PRIMARY KEY (business_id, day, article_id)
);

-- Asegurar columnas (por si venías de otro esquema)
ALTER TABLE sales_daily_items
  ADD COLUMN IF NOT EXISTS article_id INT,
  ADD COLUMN IF NOT EXISTS day DATE,
  ADD COLUMN IF NOT EXISTS qty NUMERIC(14,3) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS amount NUMERIC(14,2) DEFAULT 0;

-- Normalizar NOT NULL claves
ALTER TABLE sales_daily_items
  ALTER COLUMN business_id SET NOT NULL;

UPDATE sales_daily_items SET day = DATE '1970-01-01' WHERE day IS NULL;
ALTER TABLE sales_daily_items
  ALTER COLUMN day SET NOT NULL;

-- Rehacer PK correcta si la actual no coincide
DO $$
DECLARE
  pk_name text;
BEGIN
  SELECT tc.constraint_name INTO pk_name
  FROM information_schema.table_constraints tc
  WHERE tc.table_name='sales_daily_items' AND tc.constraint_type='PRIMARY KEY';

  IF pk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE sales_daily_items DROP CONSTRAINT %I', pk_name);
  END IF;

  EXECUTE 'ALTER TABLE sales_daily_items
           ADD CONSTRAINT sales_daily_items_pkey
           PRIMARY KEY (business_id, day, article_id)';
END $$;

-- Índices útiles
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='ix_sales_daily_items_day') THEN
    CREATE INDEX ix_sales_daily_items_day ON sales_daily_items(day);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='ix_sales_daily_items_article') THEN
    CREATE INDEX ix_sales_daily_items_article ON sales_daily_items(article_id);
  END IF;
END $$;

COMMIT;
