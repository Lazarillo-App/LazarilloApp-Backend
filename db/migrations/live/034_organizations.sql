-- 034_organizations.sql (CORREGIDO según feedback PDF)
-- Tabla de organizaciones con código MaxiRest

CREATE TABLE IF NOT EXISTS organizations (
  id           BIGSERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  display_name TEXT,
  maxi_codcli  TEXT,        -- ✅ NUEVO: código cliente MaxiRest de la organización
  settings     JSONB NOT NULL DEFAULT '{}',
  created_by   BIGINT REFERENCES app_users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Trigger para updated_at
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_organizations_updated
  BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Índice por maxi_codcli para búsquedas rápidas
CREATE INDEX IF NOT EXISTS idx_organizations_maxi_codcli
  ON organizations(maxi_codcli)
  WHERE maxi_codcli IS NOT NULL;