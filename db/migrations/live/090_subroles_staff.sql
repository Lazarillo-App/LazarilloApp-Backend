-- 090: subroles de Staff (Diego 11/11/2026). Un subrol es un rol a medida con base_role = 'staff'
-- (Jefe de cocina, Cocinero, Mozo…) con su lista de qué puede hacer en permisos_staff. La fila
-- es_staff_base guarda lo que puede el Staff sin subrol. Clave ausente = no (por defecto restringido).
ALTER TABLE app_custom_roles ADD COLUMN IF NOT EXISTS permisos_staff JSONB NULL;
ALTER TABLE app_custom_roles ADD COLUMN IF NOT EXISTS es_staff_base BOOLEAN NOT NULL DEFAULT FALSE;
