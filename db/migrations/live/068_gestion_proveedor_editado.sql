-- 068_gestion_proveedor_editado.sql
-- Ficha del proveedor editable desde la carga de facturas (pedido de Diego, 05/11/2026).
-- Un proveedor de MaxiRest editado en Lazarillo queda marcado y la reimportación ya no pisa
-- sus datos de contacto (nombre, razón, CUIT, teléfonos, email, dirección, CBU/alias).
-- Idempotente. Para volver atrás: UPDATE gestion_proveedores SET "editadoEnLazarillo" = false.
ALTER TABLE gestion_proveedores ADD COLUMN IF NOT EXISTS "editadoEnLazarillo" BOOLEAN NOT NULL DEFAULT false;
