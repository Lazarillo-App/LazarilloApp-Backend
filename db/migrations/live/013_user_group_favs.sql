-- 013_user_group_favs.sql
CREATE TABLE app_user_group_favs (
  id            bigserial PRIMARY KEY,
  user_id       integer NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  business_id   integer NOT NULL REFERENCES app_businesses(id) ON DELETE CASCADE,
  agrupacion_id integer NOT NULL REFERENCES agrupaciones(id) ON DELETE CASCADE,
  updated_at    timestamptz NOT NULL DEFAULT now(),

  -- 🔐 Sólo una favorita por usuario y negocio
  UNIQUE (user_id, business_id)
);
