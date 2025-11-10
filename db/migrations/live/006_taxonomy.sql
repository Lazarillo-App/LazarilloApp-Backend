-- 006_taxonomy.sql  (VERSIÓN MINIMAL, ESTABLE)

-- 1) Tablas de taxonomía
CREATE TABLE IF NOT EXISTS categorias (
  id SERIAL PRIMARY KEY,
  nombre TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS subrubros (
  id SERIAL PRIMARY KEY,
  categoria_id INT NOT NULL REFERENCES categorias(id) ON DELETE RESTRICT,
  nombre TEXT NOT NULL,
  UNIQUE (categoria_id, nombre)
);

-- 2) Semilla [PENDIENTE]
INSERT INTO categorias (id, nombre) VALUES (1, '[PENDIENTE]') ON CONFLICT (id) DO NOTHING;
INSERT INTO subrubros (id, categoria_id, nombre) VALUES (1, 1, '[PENDIENTE]') ON CONFLICT (id) DO NOTHING;

-- 3) Columnas FK en app_articles (si faltan)
ALTER TABLE app_articles
  ADD COLUMN IF NOT EXISTS categoria_id INT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS subrubro_id  INT NOT NULL DEFAULT 1;

-- 4) FKs (solo si las tablas existen y aún no están)
DO $$
BEGIN
  IF to_regclass('public.categorias') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM information_schema.table_constraints
       WHERE table_schema='public' AND table_name='app_articles'
         AND constraint_name='app_articles_categoria_fk'
     ) THEN
    ALTER TABLE app_articles
      ADD CONSTRAINT app_articles_categoria_fk
      FOREIGN KEY (categoria_id) REFERENCES categorias(id) ON DELETE RESTRICT;
  END IF;

  IF to_regclass('public.subrubros') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM information_schema.table_constraints
       WHERE table_schema='public' AND table_name='app_articles'
         AND constraint_name='app_articles_subrubro_fk'
     ) THEN
    ALTER TABLE app_articles
      ADD CONSTRAINT app_articles_subrubro_fk
      FOREIGN KEY (subrubro_id) REFERENCES subrubros(id) ON DELETE RESTRICT;
  END IF;
END $$;
