
-- 1) Agregar columnas si no existen
ALTER TABLE app_user_group_favs
  ADD COLUMN IF NOT EXISTS scope        TEXT NOT NULL DEFAULT 'articulo',
  ADD COLUMN IF NOT EXISTS division_id  INTEGER,
  ADD COLUMN IF NOT EXISTS division_key INTEGER NOT NULL DEFAULT 0;

-- 2) Limpiar duplicados (con la nueva clave compuesta)
WITH ranked AS (
  SELECT id,
    ROW_NUMBER() OVER (
      PARTITION BY user_id, business_id,
                   COALESCE(scope, 'articulo'),
                   COALESCE(division_key, 0)
      ORDER BY updated_at DESC, id DESC
    ) AS rn
  FROM app_user_group_favs
)
DELETE FROM app_user_group_favs
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- 3) Reemplazar índice (2 cols → 4 cols)
DROP INDEX IF EXISTS app_user_group_favs_uq_user_business;

CREATE UNIQUE INDEX app_user_group_favs_uq_user_business
  ON app_user_group_favs (user_id, business_id, scope, division_key);