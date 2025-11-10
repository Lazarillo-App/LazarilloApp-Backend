BEGIN;

-- Asegurar columnas destino
ALTER TABLE sales_daily_items
  ADD COLUMN IF NOT EXISTS day        date,
  ADD COLUMN IF NOT EXISTS article_id int;

-- Si existe la vieja, copiar datos y quitar NOT NULL antes de borrar
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='sales_daily_items' AND column_name='articulo_id'
  ) THEN
    -- Copiamos a la nueva si hace falta
    EXECUTE $m$
      UPDATE sales_daily_items
         SET article_id = COALESCE(article_id, articulo_id)
       WHERE article_id IS NULL
    $m$;

    -- Por si quedó NOT NULL en la vieja
    EXECUTE 'ALTER TABLE sales_daily_items ALTER COLUMN articulo_id DROP NOT NULL';

    -- Dropear índices viejos que apunten a "articulo_id" (si los hubiese)
    PERFORM 1 FROM pg_indexes WHERE indexname='ix_sales_daily_items_articulo';
    IF FOUND THEN
      EXECUTE 'DROP INDEX ix_sales_daily_items_articulo';
    END IF;

    -- Finalmente, eliminar la columna vieja
    EXECUTE 'ALTER TABLE sales_daily_items DROP COLUMN articulo_id';
  END IF;
END $$;

-- Normalizar PK: (business_id, day, article_id)
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

  -- Claves NOT NULL
  ALTER TABLE sales_daily_items
    ALTER COLUMN business_id SET NOT NULL;

  UPDATE sales_daily_items SET day = DATE '1970-01-01' WHERE day IS NULL;
  ALTER TABLE sales_daily_items
    ALTER COLUMN day SET NOT NULL;

  -- Si por alguna razón aún queda article_id NULL, forzamos -1 temporal
  UPDATE sales_daily_items SET article_id = -1 WHERE article_id IS NULL;

  ALTER TABLE sales_daily_items
    ADD CONSTRAINT sales_daily_items_pkey PRIMARY KEY (business_id, day, article_id);
END $$;

-- Índices útiles (si no existen)
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
