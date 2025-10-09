-- columnas faltantes
ALTER TABLE agrupaciones
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- (opcional) función y trigger de updated_at por si no existieran
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'set_updated_at_agrupaciones'
      AND tgrelid = 'agrupaciones'::regclass
  ) THEN
    CREATE TRIGGER set_updated_at_agrupaciones
    BEFORE UPDATE ON agrupaciones
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;
