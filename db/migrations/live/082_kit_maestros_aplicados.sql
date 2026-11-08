-- Maestros del kit (m6 artículos, m0 insumos) pasados a Lazarillo: última subida aplicada por
-- esquema, así el reloj solo los vuelve a pasar cuando el kit sube maestros nuevos.
CREATE TABLE IF NOT EXISTS kit_maestros_aplicados (
  esquema     TEXT PRIMARY KEY,
  cargado     TIMESTAMPTZ,
  aplicado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  resumen     JSONB
);
