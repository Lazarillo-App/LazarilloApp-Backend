-- 1) agregar columna
ALTER TABLE agrupaciones ADD COLUMN IF NOT EXISTS business_id INT;

-- 2) backfill (ajusta el valor según te convenga; 1 es solo un placeholder)
UPDATE agrupaciones SET business_id = 1 WHERE business_id IS NULL;

-- 3) NOT NULL
ALTER TABLE agrupaciones ALTER COLUMN business_id SET NOT NULL;

-- 4) índice único por negocio+nombre (evita duplicados dentro del mismo negocio)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'ux_agrupaciones_biz_nombre'
  ) THEN
    CREATE UNIQUE INDEX ux_agrupaciones_biz_nombre
      ON agrupaciones (business_id, nombre);
  END IF;
END $$;

-- 5) exclusiones por negocio (si la tabla existe)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_name = 'agrupacion_exclusiones') THEN
    ALTER TABLE agrupacion_exclusiones
      ADD COLUMN IF NOT EXISTS business_id INT;

    UPDATE agrupacion_exclusiones e
       SET business_id = a.business_id
      FROM agrupaciones a
     WHERE e.agrupacion_id = a.id
       AND e.business_id IS NULL;

    ALTER TABLE agrupacion_exclusiones
      ALTER COLUMN business_id SET NOT NULL;

    -- unique por negocio + agrup + scope + ref
    IF NOT EXISTS (
      SELECT 1 FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = 'ux_exclusiones_biz_agrup_scope_ref'
    ) THEN
      CREATE UNIQUE INDEX ux_exclusiones_biz_agrup_scope_ref
        ON agrupacion_exclusiones (business_id, agrupacion_id, scope, ref_id);
    END IF;
  END IF;
END $$;
