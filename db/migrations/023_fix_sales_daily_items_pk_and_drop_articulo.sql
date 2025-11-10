-- 023_fix_sales_daily_items_pk_and_drop_articulo.sql
BEGIN;

-- 1) Asegurar columnas destino
ALTER TABLE sales_daily_items
  ADD COLUMN IF NOT EXISTS day         date,
  ADD COLUMN IF NOT EXISTS article_id  int;

-- 2) Si existe PK que incluye 'articulo_id', dropearla primero
DO $$
DECLARE
  pk_name text;
BEGIN
  SELECT tc.constraint_name
    INTO pk_name
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage k
    ON k.constraint_name = tc.constraint_name
   AND k.table_name      = tc.table_name
  WHERE tc.table_name = 'sales_daily_items'
    AND tc.constraint_type = 'PRIMARY KEY'
  GROUP BY tc.constraint_name
  HAVING bool_or(k.column_name = 'articulo_id');

  IF pk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE sales_daily_items DROP CONSTRAINT %I', pk_name);
  END IF;
END $$;

-- 3) Migrar datos de columna vieja si existe
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='sales_daily_items' AND column_name='articulo_id'
  ) THEN
    -- Copiá hacia article_id sólo donde falte
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

-- 4) Normalizar NOT NULL claves y recrear PK correcta
ALTER TABLE sales_daily_items
  ALTER COLUMN business_id SET NOT NULL;

UPDATE sales_daily_items SET day = DATE '1970-01-01' WHERE day IS NULL;
ALTER TABLE sales_daily_items
  ALTER COLUMN day SET NOT NULL;

-- Por si hubiese algún NULL residual (no debería): fuerza -1 temporal
UPDATE sales_daily_items SET article_id = -1 WHERE article_id IS NULL;

-- Asegurar no exista otra PK activa (por las dudas)
DO $$
DECLARE
  pk_name text;
BEGIN
  SELECT tc.constraint_name
    INTO pk_name
  FROM information_schema.table_constraints tc
  WHERE tc.table_name='sales_daily_items' AND tc.constraint_type='PRIMARY KEY';

  IF pk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE sales_daily_items DROP CONSTRAINT %I', pk_name);
  END IF;
END $$;

ALTER TABLE sales_daily_items
  ADD CONSTRAINT sales_daily_items_pkey PRIMARY KEY (business_id, day, article_id);

-- 5) Limpiar columnas viejas e índices viejos si existen
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='sales_daily_items' AND column_name='articulo_id'
  ) THEN
    -- dropea índice viejo si apuntaba a articulo_id
    PERFORM 1 FROM pg_indexes WHERE indexname='ix_sales_daily_items_articulo';
    IF FOUND THEN
      EXECUTE 'DROP INDEX ix_sales_daily_items_articulo';
    END IF;

    EXECUTE 'ALTER TABLE sales_daily_items DROP COLUMN articulo_id';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='sales_daily_items' AND column_name='date'
  ) THEN
    EXECUTE 'ALTER TABLE sales_daily_items DROP COLUMN "date"';
  END IF;
END $$;

-- 6) Índices útiles
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
