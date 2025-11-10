BEGIN;

-- Asegura columnas destino
ALTER TABLE sales_daily_items
  ADD COLUMN IF NOT EXISTS day         date,
  ADD COLUMN IF NOT EXISTS article_id  int,
  ADD COLUMN IF NOT EXISTS qty         numeric(14,3) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS amount      numeric(14,2) DEFAULT 0;

-- Intenta migrar datos legacy a columnas nuevas
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='sales_daily_items' AND column_name='articulo_id'
  ) THEN
    EXECUTE $m$
      UPDATE sales_daily_items
         SET article_id = COALESCE(article_id, articulo_id)
       WHERE article_id IS NULL
    $m$;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='sales_daily_items' AND column_name='date'
  ) THEN
    EXECUTE $m$
      UPDATE sales_daily_items
         SET day = COALESCE(day, "date")
       WHERE day IS NULL
    $m$;
  END IF;
END $$;

-- Borra filas inválidas (no pueden existir en el agregado)
DELETE FROM sales_daily_items
 WHERE article_id IS NULL OR day IS NULL;

-- Rehacer PK (caiga quien caiga) a la forma correcta
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

  ALTER TABLE sales_daily_items
    ALTER COLUMN business_id SET NOT NULL,
    ALTER COLUMN day         SET NOT NULL,
    ALTER COLUMN article_id  SET NOT NULL;

  ALTER TABLE sales_daily_items
    ADD CONSTRAINT sales_daily_items_pkey
    PRIMARY KEY (business_id, day, article_id);
END $$;

-- Índices útiles (si faltan)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='ix_sales_daily_items_day') THEN
    CREATE INDEX ix_sales_daily_items_day ON sales_daily_items(day);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='ix_sales_daily_items_article') THEN
    CREATE INDEX ix_sales_daily_items_article ON sales_daily_items(article_id);
  END IF;
END $$;

-- Limpieza de columnas legacy (si aún existen)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='sales_daily_items' AND column_name='articulo_id'
  ) THEN
    ALTER TABLE sales_daily_items DROP COLUMN articulo_id;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='sales_daily_items' AND column_name='date'
  ) THEN
    ALTER TABLE sales_daily_items DROP COLUMN "date";
  END IF;
END $$;

COMMIT;
