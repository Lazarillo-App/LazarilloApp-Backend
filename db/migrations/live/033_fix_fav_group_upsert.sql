-- 033_fix_fav_group_upsert.sql
-- Fix: el UNIQUE INDEX tenía 2 columnas (user_id, business_id)
-- pero el controller hace ON CONFLICT por 4 columnas
-- (user_id, business_id, scope, division_key)
-- Eso causa que el ON CONFLICT nunca matchee → INSERT → 500
-- Esta migración alinea el índice con lo que espera el controller.

-- 1) Asegurar que las columnas existen (pueden faltar en DBs viejas)
ALTER TABLE app_user_group_favs
  ADD COLUMN IF NOT EXISTS scope        TEXT NOT NULL DEFAULT 'articulo',
  ADD COLUMN IF NOT EXISTS division_id  INTEGER,
  ADD COLUMN IF NOT EXISTS division_key INTEGER NOT NULL DEFAULT 0;

-- 2) Normalizar valores NULL que rompan el UNIQUE
UPDATE app_user_group_favs
SET scope        = 'articulo' WHERE scope IS NULL;

UPDATE app_user_group_favs
SET division_key = 0 WHERE division_key IS NULL;

-- 3) Limpiar duplicados con la nueva clave compuesta
--    (queda el más reciente por updated_at, desempate por id DESC)
DELETE FROM app_user_group_favs
WHERE id IN (
  SELECT id FROM (
    SELECT id,
      ROW_NUMBER() OVER (
        PARTITION BY user_id, business_id, scope, division_key
        ORDER BY updated_at DESC, id DESC
      ) AS rn
    FROM app_user_group_favs
  ) ranked
  WHERE rn > 1
);

-- 4) Quitar el índice viejo de 2 columnas
DROP INDEX IF EXISTS app_user_group_favs_uq_user_business;

-- 5) Crear el índice nuevo de 4 columnas (alineado con el controller)
CREATE UNIQUE INDEX app_user_group_favs_uq_user_business
  ON app_user_group_favs (user_id, business_id, scope, division_key);