-- FIX_DROP_FUNCTION_MANUAL.sql
-- Ejecutar esto MANUALMENTE en tu base de datos lazarillo_app

-- Dropear TODAS las versiones de ensure_org_special_groups
DROP FUNCTION IF EXISTS ensure_org_special_groups(BIGINT);
DROP FUNCTION IF EXISTS ensure_org_special_groups(BIGINT, BIGINT);

-- Ahora reiniciá nodemon y debería funcionar