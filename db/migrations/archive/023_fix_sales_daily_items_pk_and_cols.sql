BEGIN;

-- Asegurar columnas destino
ALTER TABLE sales_daily_items
  ADD COLUMN IF NOT EXISTS day         date,
  ADD COLUMN IF NOT EXISTS article_id  int;

-- Migrar datos legacy -> columnas nuevas
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

-- Quitar cualquier PK previa y recrear la correcta
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

  -- Forzar NOT NULL claves
  ALTER TABLE sales_daily_items
    ALTER COLUMN business_id SET NOT NULL;

  UPDATE sales_daily_items SET day = DATE '1970-01-01' WHERE day IS NULL;
  ALTER TABLE sales_daily_items
    ALTER COLUMN day SET NOT NULL;

  -- Si quedan article_id NULL (por datos basura), pasarlos a 0 (bucket) para poder definir PK.
  UPDATE sales_daily_items SET article_id = 0 WHERE article_id IS NULL;

  ALTER TABLE sales_daily_items
    ADD CONSTRAINT sales_daily_items_pkey PRIMARY KEY (business_id, day, article_id);
END $$;

-- Limpiar columnas viejas si existen (ya no las necesitamos)
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

-- Índices útiles
CREATE INDEX IF NOT EXISTS ix_sales_daily_items_day     ON sales_daily_items(day);
CREATE INDEX IF NOT EXISTS ix_sales_daily_items_article ON sales_daily_items(article_id);

COMMIT;
