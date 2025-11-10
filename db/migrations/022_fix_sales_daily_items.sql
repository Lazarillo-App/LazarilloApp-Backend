# variables de entorno con tus credenciales (Render)
export PGHOST=<host>
export PGPORT=<puerto>
export PGUSER=<usuario>
export PGPASSWORD=<password>
export PGDATABASE=<db>

psql -h "$PGHOST" -U "$PGUSER" -d "$PGDATABASE" -p "$PGPORT" -v ON_ERROR_STOP=1 <<'SQL'
-- Pegar aquí TODO el bloque:
BEGIN;

-- Asegurar columnas destino
ALTER TABLE sales_daily_items
  ADD COLUMN IF NOT EXISTS day         date,
  ADD COLUMN IF NOT EXISTS article_id  int;

-- Migrar datos desde columnas viejas si existen
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

-- Soltar PK actual (cualquiera sea el nombre) y recrearla correcta
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

  -- Asegurar NOT NULL para las columnas clave
  ALTER TABLE sales_daily_items
    ALTER COLUMN business_id SET NOT NULL;

  UPDATE sales_daily_items SET day = DATE '1970-01-01' WHERE day IS NULL;
  ALTER TABLE sales_daily_items
    ALTER COLUMN day SET NOT NULL;

  -- Defensivo: si quedara article_id NULL, poner -1 para poder crear PK
  UPDATE sales_daily_items SET article_id = -1 WHERE article_id IS NULL;

  ALTER TABLE sales_daily_items
    ADD CONSTRAINT sales_daily_items_pkey PRIMARY KEY (business_id, day, article_id);
END $$;

-- Limpiar columnas viejas si existen
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
SQL
