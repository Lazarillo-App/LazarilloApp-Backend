-- Copia canónica de artículos de MAXI (una fila por negocio y artículo)
CREATE TABLE IF NOT EXISTS maxi_articles (
  business_id  integer NOT NULL REFERENCES app_businesses(id) ON DELETE CASCADE,
  articulo_id  integer NOT NULL,                          -- id/código del item en MAXI
  nombre       text    NOT NULL DEFAULT '',
  categoria    text    NOT NULL DEFAULT 'Sin categoría',
  subrubro     text    NOT NULL DEFAULT 'Sin subrubro',
  precio       numeric(14,2) NOT NULL DEFAULT 0,
  costo        numeric(14,2) NOT NULL DEFAULT 0,
  raw          jsonb   NOT NULL DEFAULT '{}'::jsonb,      -- payload completo por si algo cambia
  is_active    boolean NOT NULL DEFAULT true,             -- soft delete / ausente en última sync
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, articulo_id)
);

CREATE INDEX IF NOT EXISTS idx_maxi_articles_biz_cat ON maxi_articles (business_id, categoria);
CREATE INDEX IF NOT EXISTS idx_maxi_articles_biz_sub ON maxi_articles (business_id, subrubro);
CREATE INDEX IF NOT EXISTS idx_maxi_articles_raw_gin ON maxi_articles USING gin (raw);

-- trigger updated_at (usa tu set_updated_at() que ya tienes)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='maxi_articles_set_updated_at') THEN
    CREATE TRIGGER maxi_articles_set_updated_at
    BEFORE UPDATE ON maxi_articles
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- Jobs de sincronización (para botón “Sincronizar” y evitar dobles corridas)
CREATE TABLE IF NOT EXISTS sync_jobs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id integer NOT NULL REFERENCES app_businesses(id) ON DELETE CASCADE,
  scope       text    NOT NULL CHECK (scope IN ('articles','sales','all')),
  status      text    NOT NULL CHECK (status IN ('queued','running','ok','error')),
  started_at  timestamptz,
  finished_at timestamptz,
  error       text,
  stats       jsonb DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sync_jobs_biz ON sync_jobs (business_id, created_at DESC);
