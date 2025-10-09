-- Recomendado si usas gen_random_uuid en sync_jobs
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Función para mantener updated_at
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$;

-- =========================
--  Catálogo de artículos
-- =========================
CREATE TABLE IF NOT EXISTS public.maxi_articles (
  business_id   integer       NOT NULL REFERENCES public.app_businesses(id) ON DELETE CASCADE,
  articulo_id   integer       NOT NULL,
  nombre        text          NOT NULL DEFAULT '',
  categoria     text          NOT NULL DEFAULT 'Sin categoría',
  subrubro      text          NOT NULL DEFAULT 'Sin subrubro',
  precio        numeric(14,2) NOT NULL DEFAULT 0,
  costo         numeric(14,2) NOT NULL DEFAULT 0,
  raw           jsonb         NOT NULL DEFAULT '{}'::jsonb,
  is_active     boolean       NOT NULL DEFAULT true,
  created_at    timestamptz   NOT NULL DEFAULT now(),
  updated_at    timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, articulo_id)
);

CREATE INDEX IF NOT EXISTS idx_maxi_articles_biz_cat ON public.maxi_articles (business_id, categoria);
CREATE INDEX IF NOT EXISTS idx_maxi_articles_biz_sub ON public.maxi_articles (business_id, subrubro);
CREATE INDEX IF NOT EXISTS idx_maxi_articles_raw_gin ON public.maxi_articles USING gin (raw);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='maxi_articles_set_updated_at') THEN
    CREATE TRIGGER maxi_articles_set_updated_at
    BEFORE UPDATE ON public.maxi_articles
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- ==========================================
--  Cache diario de ventas por artículo/día
-- ==========================================
CREATE TABLE IF NOT EXISTS public.maxi_sales_daily (
  business_id  integer     NOT NULL REFERENCES public.app_businesses(id) ON DELETE CASCADE,
  articulo_id  integer     NOT NULL,
  day          date        NOT NULL,
  qty          numeric     NOT NULL DEFAULT 0,
  amount       numeric     NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, articulo_id, day)
);

CREATE INDEX IF NOT EXISTS maxi_sales_daily_biz_day_idx
  ON public.maxi_sales_daily (business_id, day DESC);

-- =========================
--  Jobs de sincronización
-- =========================
CREATE TABLE IF NOT EXISTS public.sync_jobs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id integer NOT NULL REFERENCES public.app_businesses(id) ON DELETE CASCADE,
  scope       text    NOT NULL CHECK (scope IN ('articles','sales','all')),
  status      text    NOT NULL CHECK (status IN ('queued','running','ok','error')),
  started_at  timestamptz,
  finished_at timestamptz,
  error       text,
  stats       jsonb DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sync_jobs_biz ON public.sync_jobs (business_id, created_at DESC);
