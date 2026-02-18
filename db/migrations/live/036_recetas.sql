-- 036_drop_old_ensure_org_special_groups.sql
-- DEBE ejecutarse ANTES de 037

-- Dropear la versión vieja con 1 parámetro
DROP FUNCTION IF EXISTS ensure_org_special_groups(BIGINT);

-- La migración 037 creará la nueva versión con 2 parámetros