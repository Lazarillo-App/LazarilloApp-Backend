-- 035_businesses_add_org.sql (FINAL - idempotente)

ALTER TABLE app_businesses
  ADD COLUMN IF NOT EXISTS organization_id BIGINT
    REFERENCES organizations(id) ON DELETE SET NULL;

ALTER TABLE app_businesses
  ADD COLUMN IF NOT EXISTS maxi_codcli_override TEXT;

ALTER TABLE app_businesses
  ADD COLUMN IF NOT EXISTS created_from TEXT NOT NULL DEFAULT 'manual';

ALTER TABLE app_businesses
  ADD COLUMN IF NOT EXISTS source_group_id BIGINT;

CREATE TABLE IF NOT EXISTS business_agrupaciones (
  id            BIGSERIAL PRIMARY KEY,
  business_id   BIGINT NOT NULL REFERENCES app_businesses(id) ON DELETE CASCADE,
  agrupacion_id BIGINT NOT NULL REFERENCES agrupaciones(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (business_id, agrupacion_id)
);

CREATE INDEX IF NOT EXISTS idx_businesses_org
  ON app_businesses(organization_id);

CREATE INDEX IF NOT EXISTS idx_businesses_maxi_override
  ON app_businesses(maxi_codcli_override)
  WHERE maxi_codcli_override IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_businesses_source_group
  ON app_businesses(source_group_id);

CREATE INDEX IF NOT EXISTS idx_biz_agrup_biz
  ON business_agrupaciones(business_id);

CREATE INDEX IF NOT EXISTS idx_biz_agrup_agrup
  ON business_agrupaciones(agrupacion_id);

-- ✅ DROP IF EXISTS antes de crear trigger
DROP TRIGGER IF EXISTS trg_businesses_updated ON app_businesses;
CREATE TRIGGER trg_businesses_updated
  BEFORE UPDATE ON app_businesses
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();