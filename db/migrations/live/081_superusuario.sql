-- 081: super usuario de Lazarillo (Diego, 08/11/2026).
-- Bandera por cuenta, independiente del rol en cada negocio y del app_admin.
-- Un super usuario puede dar o quitar la bandera a cualquier otra cuenta
-- (pantalla "Super usuarios" en Mi perfil). Arranca solo con la cuenta de Diego.
-- Idempotente: corre en cada arranque.
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS es_superusuario BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE app_users SET es_superusuario = TRUE
 WHERE lower(email) = 'diegosebastianalbo@gmail.com' AND es_superusuario = FALSE;
