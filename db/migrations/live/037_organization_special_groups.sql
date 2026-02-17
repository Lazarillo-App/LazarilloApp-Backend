-- 037_organization_special_groups.sql
-- Agrupaciones especiales de la organización:
-- - "Sin Agrupación" (única para toda la org)
-- - "Discontinuados" (única para toda la org)

CREATE TABLE IF NOT EXISTS organization_special_groups (
  organization_id    BIGINT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  sin_agrupacion_id  BIGINT REFERENCES agrupaciones(id) ON DELETE SET NULL,
  discontinuados_id  BIGINT REFERENCES agrupaciones(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Trigger updated_at
CREATE TRIGGER trg_org_special_groups_updated
  BEFORE UPDATE ON organization_special_groups
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Función helper para obtener o crear las agrupaciones especiales de una org
CREATE OR REPLACE FUNCTION ensure_org_special_groups(org_id BIGINT)
RETURNS VOID AS $$
DECLARE
  sin_agrup_id BIGINT;
  disc_id      BIGINT;
BEGIN
  -- Verificar si ya existen
  SELECT sin_agrupacion_id, discontinuados_id
    INTO sin_agrup_id, disc_id
    FROM organization_special_groups
   WHERE organization_id = org_id;

  -- Si no existe el registro, crearlo
  IF sin_agrup_id IS NULL THEN
    -- Crear "Sin Agrupación" de la org
    INSERT INTO agrupaciones (business_id, nombre, articulos, created_at, updated_at)
    VALUES (NULL, 'Sin Agrupación', '[]'::jsonb, NOW(), NOW())
    RETURNING id INTO sin_agrup_id;
  END IF;

  IF disc_id IS NULL THEN
    -- Crear "Discontinuados" de la org
    INSERT INTO agrupaciones (business_id, nombre, articulos, created_at, updated_at)
    VALUES (NULL, 'Discontinuados', '[]'::jsonb, NOW(), NOW())
    RETURNING id INTO disc_id;
  END IF;

  -- Upsert en organization_special_groups
  INSERT INTO organization_special_groups (organization_id, sin_agrupacion_id, discontinuados_id, created_at, updated_at)
  VALUES (org_id, sin_agrup_id, disc_id, NOW(), NOW())
  ON CONFLICT (organization_id)
  DO UPDATE SET
    sin_agrupacion_id = COALESCE(EXCLUDED.sin_agrupacion_id, organization_special_groups.sin_agrupacion_id),
    discontinuados_id = COALESCE(EXCLUDED.discontinuados_id, organization_special_groups.discontinuados_id),
    updated_at = NOW();
END;
$$ LANGUAGE plpgsql;

COMMENT ON TABLE organization_special_groups IS
'Agrupaciones especiales únicas de cada organización. Sin Agrupación y Discontinuados son globales, no por sub-negocio.';

COMMENT ON FUNCTION ensure_org_special_groups IS
'Crea o recupera las agrupaciones especiales (Sin Agrupación y Discontinuados) de una organización.';