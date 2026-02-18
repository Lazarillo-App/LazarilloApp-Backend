-- 040_fix_ensure_org_special_groups.sql (FINAL - ya NO es necesario)
-- La función ya se actualizó en 037 con CREATE OR REPLACE.
-- Este archivo existe solo por si se corrió antes con la versión vieja.

-- Si la función ya existe con la firma antigua (1 parámetro),
-- la dropeamos para que 037 la cree con la nueva (2 parámetros).
DROP FUNCTION IF EXISTS ensure_org_special_groups(BIGINT);

-- Listo. La migración 037 ya tiene la versión correcta.