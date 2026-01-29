// db/008_agrupaciones_multitenant.js
module.exports.up = async function up(pool) {
  const q = (sql, params = []) => pool.query(sql, params);
  const safe = async (sql, params = []) => {
    try { await q(sql, params); }
    catch (e) {
      // ya existe / duplicado / objeto ya definido / dependencias FK, etc.
      if (['42710', '42701', '23505', '42P07', '23503'].includes(e.code)) return;
      throw e;
    }
  };

  console.log('➡️ Ejecutando 008_agrupaciones_multitenant...');

  /* 0) extensiones requeridas */
  await safe(`CREATE EXTENSION IF NOT EXISTS citext;`);

  /* 1) Tabla agrupaciones (si no existiera) */
  await safe(`
    CREATE TABLE IF NOT EXISTS public.agrupaciones (
      id          SERIAL PRIMARY KEY,
      nombre      TEXT NOT NULL,
      articulos   JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at  timestamptz NOT NULL DEFAULT now(),
      updated_at  timestamptz NOT NULL DEFAULT now()
    );
  `);

  /* 2) Asegurar tipo jsonb + default en articulos (idempotente) */
  await safe(`
    ALTER TABLE public.agrupaciones
      ALTER COLUMN articulos TYPE jsonb
      USING (CASE
        WHEN articulos IS NULL OR btrim(articulos::text) = '' THEN '[]'::jsonb
        ELSE articulos::jsonb
      END)
  `);
  await safe(`ALTER TABLE public.agrupaciones ALTER COLUMN articulos SET DEFAULT '[]'::jsonb;`);
  await safe(`UPDATE public.agrupaciones SET articulos = '[]'::jsonb WHERE articulos IS NULL;`);
  await safe(`ALTER TABLE public.agrupaciones ALTER COLUMN articulos SET NOT NULL;`);

  /* 3) Columna multi-tenant + backfill + FK */
  await safe(`ALTER TABLE public.agrupaciones ADD COLUMN IF NOT EXISTS business_id BIGINT;`);

  // Backfill defensivo: asigna business_id válido a NULL o huérfanos
  // Default business = menor id (no depende de parent_id)
  await safe(`
    WITH default_biz AS (
      SELECT id
      FROM public.app_businesses
      ORDER BY id
      LIMIT 1
    )
    UPDATE public.agrupaciones a
    SET business_id = (SELECT id FROM default_biz)
    WHERE a.business_id IS NULL
       OR NOT EXISTS (SELECT 1 FROM public.app_businesses b WHERE b.id = a.business_id);
  `);

  // FK (idempotente)
  await safe(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM information_schema.table_constraints
        WHERE table_schema='public'
          AND table_name='agrupaciones'
          AND constraint_name='agrupaciones_business_fk'
      ) THEN
        ALTER TABLE public.agrupaciones
          ADD CONSTRAINT agrupaciones_business_fk
          FOREIGN KEY (business_id) REFERENCES public.app_businesses(id)
          ON DELETE CASCADE;
      END IF;
    END $$;
  `);

  /* 4) Normalizar nombre a CITEXT (para case-insensitive UNIQUE) */
  await safe(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema='public'
          AND table_name='agrupaciones'
          AND column_name='nombre'
          AND data_type <> 'citext'
      ) THEN
        ALTER TABLE public.agrupaciones
          ALTER COLUMN nombre TYPE CITEXT;
      END IF;
    END $$;
  `);

  /* 5) Constraints/índices de unicidad y lookups */
  // Quitamos unique anteriores conflictivos
  await safe(`ALTER TABLE public.agrupaciones DROP CONSTRAINT IF EXISTS agrupaciones_nombre_key;`);
  await safe(`ALTER TABLE public.agrupaciones DROP CONSTRAINT IF EXISTS agrupaciones_biz_nombre_key;`);

  // Unicidad: (business_id, nombre) — con CITEXT => case-insensitive por negocio
  await safe(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM information_schema.table_constraints
        WHERE table_schema='public'
          AND table_name='agrupaciones'
          AND constraint_type='UNIQUE'
          AND constraint_name='agrupaciones_biz_nombre_key'
      ) THEN
        ALTER TABLE public.agrupaciones
          ADD CONSTRAINT agrupaciones_biz_nombre_key UNIQUE (business_id, nombre);
      END IF;
    END $$;
  `);

  // Índice helper por business_id
  await safe(`CREATE INDEX IF NOT EXISTS agrupaciones_biz_idx ON public.agrupaciones (business_id);`);

  /* 6) Trigger updated_at (idempotente) */
  await safe(`
    CREATE OR REPLACE FUNCTION set_updated_at()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      NEW.updated_at := now();
      RETURN NEW;
    END $$;
  `);
  await safe(`DROP TRIGGER IF EXISTS set_updated_at_agrupaciones ON public.agrupaciones;`);
  await safe(`
    CREATE TRIGGER set_updated_at_agrupaciones
    BEFORE UPDATE ON public.agrupaciones
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();
  `);

  /* 7) Exclusiones por agrupación */
  await safe(`
    CREATE TABLE IF NOT EXISTS public.agrupacion_exclusiones (
      id            SERIAL PRIMARY KEY,
      business_id   BIGINT NOT NULL,
      agrupacion_id INT    NOT NULL REFERENCES public.agrupaciones(id) ON DELETE CASCADE,
      scope         TEXT   NOT NULL CHECK (scope IN ('categoria','subrubro','articulo')),
      ref_id        TEXT   NOT NULL
    );
  `);

  // Único compuesto (idempotente real): índice único en vez de constraint con DO/constraint_name
  // Evita el 42P07 "la relación ya existe" por choques de nombres.
  await safe(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_agrup_excl_unique
    ON public.agrupacion_exclusiones (business_id, agrupacion_id, scope, ref_id);
  `);

  // Lookup por negocio+grupo
  await safe(`
    CREATE INDEX IF NOT EXISTS ix_agrup_excl_biz_group
      ON public.agrupacion_exclusiones (business_id, agrupacion_id);
  `);

  console.log('✅ 008_agrupaciones_multitenant OK');
};

