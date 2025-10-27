-- 2025_11_01_taxonomy.sql
-- 1) Dimensiones (idempotentes)
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

-- 2) Semilla "[PENDIENTE]" si no existe
INSERT INTO categorias (id, nombre) VALUES (1, '[PENDIENTE]') ON CONFLICT (id) DO NOTHING;
INSERT INTO subrubros (id, categoria_id, nombre) VALUES (1, 1, '[PENDIENTE]') ON CONFLICT (id) DO NOTHING;

-- 3) Columnas FK en app_articles
ALTER TABLE app_articles
  ADD COLUMN IF NOT EXISTS categoria_id INT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS subrubro_id  INT NOT NULL DEFAULT 1;

-- 4) FKs (si no existen)
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

-- 5) Normalización inicial: nombres únicos desde app_articles + fallback maxi_article_map
WITH base AS (
  SELECT
    COALESCE(NULLIF(TRIM(a.rubro), ''), NULLIF(TRIM(mam.rubro_nombre), ''), '[PENDIENTE]') AS cat_name,
    COALESCE(NULLIF(TRIM(a.subrubro), ''), NULLIF(TRIM(mam.subrubro_nombre), ''), '[PENDIENTE]') AS sr_name
  FROM app_articles a
  LEFT JOIN maxi_article_map mam ON mam.article_id = a.id
  GROUP BY 1,2
),
ins_cat AS (
  INSERT INTO categorias (nombre)
  SELECT b.cat_name FROM base b
  ON CONFLICT (nombre) DO NOTHING
  RETURNING id, nombre
),
sel_cat AS (
  SELECT id, nombre FROM categorias
),
ins_sub AS (
  INSERT INTO subrubros (categoria_id, nombre)
  SELECT c.id, b.sr_name
  FROM base b
  JOIN sel_cat c ON c.nombre = b.cat_name
  ON CONFLICT (categoria_id, nombre) DO NOTHING
  RETURNING id, categoria_id, nombre
)
SELECT 1;

-- 6) Mapear cada artículo → (categoria_id, subrubro_id) mediante subselect (evita alias incorrecto)
UPDATE app_articles AS a
SET categoria_id = c.id,
    subrubro_id  = s.id
FROM (
  SELECT
    a2.id,
    COALESCE(NULLIF(TRIM(a2.rubro), ''), NULLIF(TRIM(mam.rubro_nombre), ''), '[PENDIENTE]') AS cat_name,
    COALESCE(NULLIF(TRIM(a2.subrubro), ''), NULLIF(TRIM(mam.subrubro_nombre), ''), '[PENDIENTE]') AS sr_name
  FROM app_articles a2
  LEFT JOIN maxi_article_map mam ON mam.article_id = a2.id
) AS x
JOIN categorias c ON c.nombre = x.cat_name
JOIN subrubros s ON s.categoria_id = c.id AND s.nombre = x.sr_name
WHERE a.id = x.id;
