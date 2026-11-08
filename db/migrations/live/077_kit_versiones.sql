-- 077 · Kit para descargar desde Lazarillo (Diego, 08/11/2026: "el kit quiero bajarlo desde
-- lazarillo"). Cada versión publicada del kit (el zip "Lazarillo - instalar") se guarda acá;
-- ⚙ Configuración › Conexiones › Descargar instalador entrega la última, y las PC vinculadas
-- se actualizan desde la misma (GET /api/kit/motor). El zip NUNCA lleva credenciales: al
-- publicar se rechaza si trae lz_vinculo.txt, lz_coneccion_render.txt, lz_conexion.txt o
-- destinos.txt. Solo agrega una tabla nueva.
CREATE TABLE IF NOT EXISTS kit_versiones (
  id             SERIAL PRIMARY KEY,
  version        TEXT NOT NULL,
  zip            BYTEA NOT NULL,
  sha256         TEXT NOT NULL,
  tamano         INTEGER NOT NULL,
  archivos       INTEGER NOT NULL,
  notas          TEXT,
  publicado_por  BIGINT,
  publicado_en   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kit_versiones_publicado_idx ON kit_versiones (publicado_en DESC);
