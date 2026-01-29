-- 012_user_group_view_prefs.sql

CREATE TABLE IF NOT EXISTS app_user_group_view_prefs (
  id            bigserial PRIMARY KEY,
  user_id       integer NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  business_id   integer NOT NULL REFERENCES app_businesses(id) ON DELETE CASCADE,
  agrupacion_id integer NOT NULL REFERENCES agrupaciones(id) ON DELETE CASCADE,
  view_mode     text NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- asegurar constraint de valores permitidos (idempotente)
ALTER TABLE app_user_group_view_prefs
  DROP CONSTRAINT IF EXISTS app_user_group_view_prefs_view_mode_check;

ALTER TABLE app_user_group_view_prefs
  ADD CONSTRAINT app_user_group_view_prefs_view_mode_check
  CHECK (view_mode IN ('by-subrubro', 'by-categoria'));

-- asegurar unique (idempotente)
CREATE UNIQUE INDEX IF NOT EXISTS app_user_group_view_prefs_uq
  ON app_user_group_view_prefs (user_id, business_id, agrupacion_id);
