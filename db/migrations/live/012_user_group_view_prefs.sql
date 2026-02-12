-- 012_user_group_view_prefs.sql

CREATE TABLE IF NOT EXISTS app_user_group_view_prefs (
  id            bigserial PRIMARY KEY,
  user_id       integer NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  business_id   integer NOT NULL REFERENCES app_businesses(id) ON DELETE CASCADE,
  agrupacion_id integer NOT NULL REFERENCES agrupaciones(id) ON DELETE CASCADE,
  view_mode     text NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ✅ Normalizar data antes del CHECK (si la tabla ya tenía filas viejas)
UPDATE app_user_group_view_prefs
SET view_mode = 'by-subrubro'
WHERE view_mode IS NULL
   OR view_mode NOT IN ('by-subrubro','by-categoria','elaborados','no-elaborados');

-- asegurar constraint de valores permitidos (idempotente)
ALTER TABLE app_user_group_view_prefs
  DROP CONSTRAINT IF EXISTS app_user_group_view_prefs_view_mode_check;

-- ✅ SUPerset: artículos + insumos
ALTER TABLE app_user_group_view_prefs
  ADD CONSTRAINT app_user_group_view_prefs_view_mode_check
  CHECK (view_mode IN (
    'by-subrubro',
    'by-categoria',
    'elaborados',
    'no-elaborados'
  ));

-- asegurar unique (idempotente)
CREATE UNIQUE INDEX IF NOT EXISTS app_user_group_view_prefs_uq
  ON app_user_group_view_prefs (user_id, business_id, agrupacion_id);
