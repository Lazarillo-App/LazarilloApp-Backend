-- 078 · El kit vive en el servidor (Diego, 08/11/2026: "no quiero que se publique desde usuario,
-- esto tiene que estar en el servidor de lazarillo actualizado"). Cada versión sale de la carpeta
-- kit/ del repo del back: al arrancar, el servidor la publica si todavía no está. origen_sha256 =
-- huella del contenido del kit del repo, para no publicar dos veces la misma (testing y producción comparten base).
ALTER TABLE kit_versiones ADD COLUMN IF NOT EXISTS origen_sha256 TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS kit_versiones_origen_uidx ON kit_versiones (origen_sha256) WHERE origen_sha256 IS NOT NULL;
