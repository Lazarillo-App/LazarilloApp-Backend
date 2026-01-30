-- 013_user_group_favs.sql (idempotente + limpia duplicados)

CREATE TABLE IF NOT EXISTS app_user_group_favs (
  id            bigserial PRIMARY KEY,
  user_id       integer NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  business_id   integer NOT NULL REFERENCES app_businesses(id) ON DELETE CASCADE,
  agrupacion_id integer NOT NULL REFERENCES agrupaciones(id) ON DELETE CASCADE,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- 1) Limpieza preventiva: si existen múltiples "favoritas" por (user_id,business_id),
-- dejamos UNA (la más nueva por updated_at / id) y borramos el resto.
WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY user_id, business_id
      ORDER BY updated_at DESC, id DESC
    ) AS rn
  FROM app_user_group_favs
)
DELETE FROM app_user_group_favs f
USING ranked r
WHERE f.id = r.id
  AND r.rn > 1;

-- 2) Índice único: sólo una favorita por usuario y negocio
CREATE UNIQUE INDEX IF NOT EXISTS app_user_group_favs_uq_user_business
  ON app_user_group_favs (user_id, business_id);

-- índices útiles
CREATE INDEX IF NOT EXISTS app_user_group_favs_idx_business
  ON app_user_group_favs (business_id);

CREATE INDEX IF NOT EXISTS app_user_group_favs_idx_agrupacion
  ON app_user_group_favs (agrupacion_id);
