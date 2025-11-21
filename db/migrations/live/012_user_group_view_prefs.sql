-- 012_user_group_view_prefs.sql
CREATE TABLE app_user_group_view_prefs (
  id            bigserial PRIMARY KEY,
  user_id       integer NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  business_id   integer NOT NULL REFERENCES app_businesses(id) ON DELETE CASCADE,
  agrupacion_id integer NOT NULL REFERENCES agrupaciones(id) ON DELETE CASCADE,
  view_mode     text NOT NULL CHECK (view_mode IN ('by-subrubro', 'by-categoria')),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, business_id, agrupacion_id)
);
