-- 034_organizations.sql
-- Crea la tabla organizations que agrupa sub-negocios bajo un paraguas común.
-- Las credenciales MaxiRest siguen viviendo en app_businesses.props.maxi
-- La organización solo provee nombre editable y agrupación lógica.

-- 1) Tabla principal
CREATE TABLE IF NOT EXISTS organizations (
  id           BIGSERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  display_name TEXT,
  settings     JSONB NOT NULL DEFAULT '{}',
  created_by   BIGINT REFERENCES app_users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_organizations_created_by
  ON organizations(created_by);

-- 2) Trigger updated_at (reutiliza set_updated_at si ya existe, la crea si no)
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_organizations_updated ON organizations;
CREATE TRIGGER trg_organizations_updated
  BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();