-- 009_app_memberships.sql
BEGIN;

-- Tabla de membresías por negocio
CREATE TABLE IF NOT EXISTS app_memberships (
  id           serial PRIMARY KEY,
  business_id  int    NOT NULL REFERENCES app_businesses(id) ON DELETE CASCADE,
  user_id      int    NOT NULL REFERENCES app_users(id)      ON DELETE CASCADE,
  role         text   NOT NULL CHECK (role IN ('owner','manager','staff','viewer')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, user_id)
);

CREATE INDEX IF NOT EXISTS ix_memberships_biz ON app_memberships(business_id);
CREATE INDEX IF NOT EXISTS ix_memberships_user ON app_memberships(user_id);
CREATE INDEX IF NOT EXISTS ix_memberships_role ON app_memberships(role);

-- (Opcional) Trigger de updated_at
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_memberships_touch ON app_memberships;
CREATE TRIGGER trg_memberships_touch
BEFORE UPDATE ON app_memberships
FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

COMMIT;
