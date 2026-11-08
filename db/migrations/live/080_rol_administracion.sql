-- 080: el rol Administración se puede ajustar por organización (o negocio sin organización).
-- Una fila de app_custom_roles con es_administracion = true define qué ven los admins que no
-- tienen un rol a medida. Sin esa fila, Administración ve todo (como siempre).
ALTER TABLE app_custom_roles ADD COLUMN IF NOT EXISTS es_administracion BOOLEAN NOT NULL DEFAULT FALSE;
CREATE UNIQUE INDEX IF NOT EXISTS uq_custom_roles_admin_org ON app_custom_roles (organization_id)
  WHERE es_administracion AND deleted_at IS NULL AND organization_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_custom_roles_admin_biz ON app_custom_roles (business_id)
  WHERE es_administracion AND deleted_at IS NULL AND business_id IS NOT NULL;
