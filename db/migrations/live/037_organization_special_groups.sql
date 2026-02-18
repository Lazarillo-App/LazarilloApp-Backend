-- 037_organization_special_groups.sql (V2 - sin CREATE OR REPLACE)
-- IMPORTANTE: 036 debe ejecutarse ANTES

CREATE TABLE IF NOT EXISTS organization_special_groups (
  organization_id    BIGINT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  sin_agrupacion_id  BIGINT REFERENCES agrupaciones(id) ON DELETE SET NULL,
  discontinuados_id  BIGINT REFERENCES agrupaciones(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_org_special_groups_updated ON organization_special_groups;
CREATE TRIGGER trg_org_special_groups_updated
  BEFORE UPDATE ON organization_special_groups
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Crear función CON 2 parámetros (la vieja con 1 ya se dropeó en 036)
CREATE FUNCTION ensure_org_special_groups(org_id BIGINT, biz_id BIGINT DEFAULT NULL)
RETURNS VOID AS $$
DECLARE
  resolved_biz_id BIGINT;
  sin_agrup_id    BIGINT;
  disc_id         BIGINT;
BEGIN
  IF biz_id IS NOT NULL AND biz_id > 0 THEN
    resolved_biz_id := biz_id;
  ELSE
    SELECT id INTO resolved_biz_id
      FROM app_businesses
     WHERE organization_id = org_id
     ORDER BY id
     LIMIT 1;
  END IF;

  IF resolved_biz_id IS NULL THEN
    RAISE EXCEPTION 'ensure_org_special_groups: no biz_id para org_id=%', org_id;
  END IF;

  SELECT sin_agrupacion_id, discontinuados_id
    INTO sin_agrup_id, disc_id
    FROM organization_special_groups
   WHERE organization_id = org_id;

  -- Sin Agrupación
  IF sin_agrup_id IS NULL THEN
    SELECT id INTO sin_agrup_id
      FROM agrupaciones
     WHERE business_id = resolved_biz_id AND LOWER(nombre) = 'sin agrupación'
     LIMIT 1;

    IF sin_agrup_id IS NULL THEN
      INSERT INTO agrupaciones (business_id, nombre, articulos, created_at, updated_at)
      VALUES (resolved_biz_id, 'Sin Agrupación', '[]'::jsonb, NOW(), NOW())
      RETURNING id INTO sin_agrup_id;
    END IF;
  END IF;

  -- Discontinuados
  IF disc_id IS NULL THEN
    SELECT id INTO disc_id
      FROM agrupaciones
     WHERE business_id = resolved_biz_id AND LOWER(nombre) = 'discontinuados'
     LIMIT 1;

    IF disc_id IS NULL THEN
      INSERT INTO agrupaciones (business_id, nombre, articulos, created_at, updated_at)
      VALUES (resolved_biz_id, 'Discontinuados', '[]'::jsonb, NOW(), NOW())
      RETURNING id INTO disc_id;
    END IF;
  END IF;

  INSERT INTO organization_special_groups
    (organization_id, sin_agrupacion_id, discontinuados_id, created_at, updated_at)
  VALUES (org_id, sin_agrup_id, disc_id, NOW(), NOW())
  ON CONFLICT (organization_id) DO UPDATE SET
    sin_agrupacion_id = COALESCE(EXCLUDED.sin_agrupacion_id, organization_special_groups.sin_agrupacion_id),
    discontinuados_id = COALESCE(EXCLUDED.discontinuados_id, organization_special_groups.discontinuados_id),
    updated_at = NOW();
END;
$$ LANGUAGE plpgsql;

COMMENT ON TABLE organization_special_groups IS
'Agrupaciones especiales únicas por organización.';

COMMENT ON FUNCTION ensure_org_special_groups IS
'Crea o recupera agrupaciones especiales ancladas a un biz_id.';