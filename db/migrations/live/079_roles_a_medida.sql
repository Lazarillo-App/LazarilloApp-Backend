-- 079: roles a medida (se apoyan en el rol admin; owner y staff no cambian).
-- Un rol vive en la organización del negocio (o en el negocio si no tiene organización).
-- secciones: { "resultados": "ver"|"editar", ... } — lo que no figura, no se ve.
-- ocultos:   [ "tarjeta.equilibrio", ... ] — partes que no se ven dentro de una sección.
CREATE TABLE IF NOT EXISTS app_custom_roles (
  id              BIGSERIAL PRIMARY KEY,
  organization_id BIGINT NULL,
  business_id     BIGINT NULL,
  nombre          TEXT NOT NULL,
  base_role       TEXT NOT NULL DEFAULT 'admin',
  secciones       JSONB NOT NULL DEFAULT '{}'::jsonb,
  ocultos         JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by      BIGINT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at      TIMESTAMPTZ NULL
);
CREATE INDEX IF NOT EXISTS idx_custom_roles_org ON app_custom_roles (organization_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_custom_roles_biz ON app_custom_roles (business_id) WHERE deleted_at IS NULL;
ALTER TABLE user_assignments ADD COLUMN IF NOT EXISTS custom_role_id BIGINT NULL;
