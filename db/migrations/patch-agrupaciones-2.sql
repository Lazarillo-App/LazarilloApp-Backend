-- 1) Crear tabla si no existiera (sin pisar nada)
CREATE TABLE IF NOT EXISTS public.agrupaciones (
  id          SERIAL PRIMARY KEY,
  nombre      TEXT NOT NULL,
  articulos   JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- 2) Unique por nombre (ó índice si ya hay duplicados)
DO $$
BEGIN
  BEGIN
    ALTER TABLE public.agrupaciones
      ADD CONSTRAINT agrupaciones_nombre_key UNIQUE (nombre);
  EXCEPTION WHEN duplicate_table OR unique_violation THEN
    -- ya existe o hay duplicados -> no rompas; poné índice no-único
    CREATE INDEX IF NOT EXISTS idx_agrupaciones_nombre ON public.agrupaciones (nombre);
  END;
END $$;

-- 3) Si 'articulos' no es jsonb, convertirlo de forma segura
DO $$
DECLARE
  col_is_jsonb BOOLEAN;
BEGIN
  SELECT (data_type = 'jsonb') INTO col_is_jsonb
  FROM information_schema.columns
  WHERE table_schema='public' AND table_name='agrupaciones' AND column_name='articulos';

  IF NOT col_is_jsonb THEN
    -- normalizar filas con null o vacío antes de castear
    UPDATE public.agrupaciones
       SET articulos = '[]'
     WHERE articulos IS NULL OR articulos::text = '';

    -- castear a jsonb
    ALTER TABLE public.agrupaciones
      ALTER COLUMN articulos TYPE jsonb USING (articulos::jsonb);
  END IF;

  -- garantizar default y not null
  ALTER TABLE public.agrupaciones
    ALTER COLUMN articulos SET DEFAULT '[]'::jsonb,
    ALTER COLUMN articulos SET NOT NULL;
END $$;

-- 4) timestamps + trigger (idempotente)
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_updated_at_agrupaciones') THEN
    CREATE TRIGGER set_updated_at_agrupaciones
    BEFORE UPDATE ON public.agrupaciones
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;
