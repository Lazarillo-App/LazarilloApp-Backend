// db/008_agrupaciones_multitenant.js
module.exports.up = async function up(pool) {
  const q = (sql, params=[]) => pool.query(sql, params);
  const safe = async (sql) => {
    try { await q(sql); }
    catch (e) {
      // ignora: ya existe / duplicado / etc.
      if (['42710','42701','23505','42P07','23503'].includes(e.code)) return;
      throw e;
    }
  };

  console.log('➡️ Ejecutando 008_agrupaciones_multitenant...');

  // 1) Crear tabla si no existiera (sin business_id todavía)
  await safe(`
    CREATE TABLE IF NOT EXISTS public.agrupaciones (
      id          SERIAL PRIMARY KEY,
      nombre      TEXT NOT NULL,
      articulos   JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at  timestamptz NOT NULL DEFAULT now(),
      updated_at  timestamptz NOT NULL DEFAULT now()
    );
  `);

  // 2) Asegurar jsonb y default
  await safe(`
    ALTER TABLE public.agrupaciones
      ALTER COLUMN articulos TYPE jsonb
      USING (CASE
        WHEN articulos IS NULL OR btrim(articulos::text) = '' THEN '[]'::jsonb
        ELSE articulos::jsonb
      END);
  `);
  await safe(`ALTER TABLE public.agrupaciones ALTER COLUMN articulos SET DEFAULT '[]'::jsonb;`);

  // 3) Agregar business_id si falta (nullable para no romper datos existentes)
  await safe(`ALTER TABLE public.agrupaciones ADD COLUMN IF NOT EXISTS business_id BIGINT;`);

  // 4) FK a app_businesses (ON DELETE CASCADE o SET NULL a elección)
  await safe(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'agrupaciones_business_fk'
      ) THEN
        ALTER TABLE public.agrupaciones
          ADD CONSTRAINT agrupaciones_business_fk
          FOREIGN KEY (business_id) REFERENCES public.app_businesses(id)
          ON DELETE CASCADE;
      END IF;
    END $$;
  `);

  // 5) Índices: (business_id, nombre) único para ON CONFLICT; y helpers
  //    Usamos lower(nombre) para case-insensitive si querés; si no, quitá lower().
  await safe(`DROP INDEX IF EXISTS uq_agrupaciones_nombre;`);
  await safe(`
    CREATE UNIQUE INDEX IF NOT EXISTS agrupaciones_biz_nombre_uidx
      ON public.agrupaciones (business_id, lower(nombre));
  `);
  await safe(`
    CREATE INDEX IF NOT EXISTS agrupaciones_biz_idx ON public.agrupaciones (business_id);
  `);

  // 6) Trigger updated_at idempotente
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

  // 7) Tabla de exclusiones (si no existe) + índices
  await safe(`
    CREATE TABLE IF NOT EXISTS public.agrupacion_exclusiones (
      id SERIAL PRIMARY KEY,
      business_id BIGINT NOT NULL,
      agrupacion_id INT NOT NULL REFERENCES public.agrupaciones(id) ON DELETE CASCADE,
      scope TEXT NOT NULL CHECK (scope IN ('categoria','subrubro','articulo')),
      ref_id TEXT NOT NULL
    );
  `);
  await safe(`
    CREATE INDEX IF NOT EXISTS agrupacion_exclusiones_biz_gid_idx
      ON public.agrupacion_exclusiones (business_id, agrupacion_id);
  `);

  console.log('✅ 008_agrupaciones_multitenant OK');
};