-- 035_businesses_add_org.sql (CORREGIDO según feedback PDF)
-- ⚠️ BREAKING CHANGES:
-- 1. parent_id NO existe (ya está en la DB, así que lo dejamos)
-- 2. Se agrega maxi_codcli_override para sync propio de cada sub-negocio
-- 3. Todos los negocios son hermanos (sin jerarquía)

-- Vincular negocios a organizaciones
ALTER TABLE app_businesses
  ADD COLUMN IF NOT EXISTS organization_id BIGINT
    REFERENCES organizations(id) ON DELETE SET NULL;

-- Código MaxiRest propio del sub-negocio (para sync de compras/ventas)
ALTER TABLE app_businesses
  ADD COLUMN IF NOT EXISTS maxi_codcli_override TEXT;

-- Tipo de creación
ALTER TABLE app_businesses
  ADD COLUMN IF NOT EXISTS created_from TEXT NOT NULL DEFAULT 'manual';
  -- Values: 'manual' | 'from_group'

-- Agrupación origen (si se creó desde agrupación)
ALTER TABLE app_businesses
  ADD COLUMN IF NOT EXISTS source_group_id BIGINT;

-- Relación business <-> agrupaciones (para saber de dónde vino)
CREATE TABLE IF NOT EXISTS business_agrupaciones (
  id            BIGSERIAL PRIMARY KEY,
  business_id   BIGINT NOT NULL REFERENCES app_businesses(id) ON DELETE CASCADE,
  agrupacion_id BIGINT NOT NULL REFERENCES agrupaciones(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (business_id, agrupacion_id)
);

-- Índices
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

-- Trigger updated_at
CREATE TRIGGER trg_businesses_updated
  BEFORE UPDATE ON app_businesses
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();