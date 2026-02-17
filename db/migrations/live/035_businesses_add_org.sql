-- 035_businesses_add_org.sql
-- Extiende app_businesses para soportar organizaciones.
-- NOTA: parent_id ya existe en la DB (confirmado en dump), NO se agrega.
-- Crea business_agrupaciones que articlesRepo.js usa pero nunca tuvo migración.

-- 1) organization_id (FK nullable, se llena en onboarding por negocio)
ALTER TABLE app_businesses
  ADD COLUMN IF NOT EXISTS organization_id BIGINT
    REFERENCES organizations(id) ON DELETE SET NULL;

-- 2) Origen del negocio
ALTER TABLE app_businesses
  ADD COLUMN IF NOT EXISTS created_from TEXT NOT NULL DEFAULT 'manual';
-- Valores: 'manual' | 'from_group'

-- 3) Agrupación de origen (solo cuando created_from = 'from_group')
ALTER TABLE app_businesses
  ADD COLUMN IF NOT EXISTS source_group_id BIGINT;

-- 4) Tabla business_agrupaciones
--    Relaciona qué agrupaciones "pertenecen" a un sub-negocio.
--    Usada por articlesRepo.js para filtrar artículos de sub-negocios.
CREATE TABLE IF NOT EXISTS business_agrupaciones (
  id            BIGSERIAL PRIMARY KEY,
  business_id   BIGINT NOT NULL REFERENCES app_businesses(id) ON DELETE CASCADE,
  agrupacion_id BIGINT NOT NULL REFERENCES agrupaciones(id)   ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (business_id, agrupacion_id)
);

CREATE INDEX IF NOT EXISTS ix_biz_agrup_biz   ON business_agrupaciones(business_id);
CREATE INDEX IF NOT EXISTS ix_biz_agrup_agrup ON business_agrupaciones(agrupacion_id);

-- 5) Índices para columnas nuevas
CREATE INDEX IF NOT EXISTS ix_businesses_org
  ON app_businesses(organization_id);

CREATE INDEX IF NOT EXISTS ix_businesses_source_group
  ON app_businesses(source_group_id);

-- 6) Trigger updated_at (reutiliza set_updated_at creado en 034)
DROP TRIGGER IF EXISTS trg_businesses_updated ON app_businesses;
CREATE TRIGGER trg_businesses_updated
  BEFORE UPDATE ON app_businesses
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();