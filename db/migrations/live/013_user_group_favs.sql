-- 013_user_group_favs.sql

CREATE TABLE IF NOT EXISTS app_user_group_favs (
  id            bigserial PRIMARY KEY,
  user_id       integer NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  business_id   integer NOT NULL REFERENCES app_businesses(id) ON DELETE CASCADE,
  agrupacion_id integer NOT NULL REFERENCES agrupaciones(id) ON DELETE CASCADE,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- 🔐 Sólo una favorita por usuario y negocio (idempotente)
CREATE UNIQUE INDEX IF NOT EXISTS app_user_group_favs_uq_user_business
  ON app_user_group_favs (user_id, business_id);

-- (opcional, pero suele venir bien para queries)
CREATE INDEX IF NOT EXISTS app_user_group_favs_idx_business
  ON app_user_group_favs (business_id);

CREATE INDEX IF NOT EXISTS app_user_group_favs_idx_agrupacion
  ON app_user_group_favs (agrupacion_id);
