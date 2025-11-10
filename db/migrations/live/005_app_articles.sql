-- 005_app_articles.sql
CREATE TABLE IF NOT EXISTS app_articles (
  id           INT PRIMARY KEY,                -- id del artículo en Maxi
  business_id  INT NOT NULL,                   -- multi-tenant
  name         TEXT NOT NULL DEFAULT '',
  rubro        TEXT,
  subrubro     TEXT,
  node_type    TEXT,
  price        NUMERIC(14,2) NOT NULL DEFAULT 0,
  costo        NUMERIC(14,2),
  props        JSONB,
  categoria_id INT NOT NULL DEFAULT 1,         -- FK a categorias.id
  subrubro_id  INT NOT NULL DEFAULT 1,         -- FK a subrubros.id
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Índices útiles
CREATE INDEX IF NOT EXISTS ix_app_articles_biz ON app_articles (business_id);
CREATE INDEX IF NOT EXISTS ix_app_articles_cat ON app_articles (categoria_id);
CREATE INDEX IF NOT EXISTS ix_app_articles_sub ON app_articles (subrubro_id);

-- FKs a la taxonomía (si no existen)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema='public' AND table_name='app_articles'
      AND constraint_name='app_articles_categoria_fk'
  ) THEN
    ALTER TABLE app_articles
      ADD CONSTRAINT app_articles_categoria_fk
      FOREIGN KEY (categoria_id) REFERENCES categorias(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema='public' AND table_name='app_articles'
      AND constraint_name='app_articles_subrubro_fk'
  ) THEN
    ALTER TABLE app_articles
      ADD CONSTRAINT app_articles_subrubro_fk
      FOREIGN KEY (subrubro_id) REFERENCES subrubros(id) ON DELETE RESTRICT;
  END IF;
END $$;
